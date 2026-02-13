# ChatGPT認証のリモート環境対応設計

## 背景・課題

現在のChatGPT (OpenAI Codex) 認証は、OAuth 2.0 + PKCE + **localhostコールバックサーバー** (port 1455) を使用している。この方式はローカル環境では動作するが、以下のリモート環境では**認証が不可能**:

- GitHub Codespaces
- SSH接続先のサーバー
- Docker/Devcontainer
- VS Code Remote (code serve-web)

**根本原因**: ブラウザが動作するマシンと、CLIが動作するマシンが異なるため、`http://localhost:1455/auth/callback` にリダイレクトしてもCLI側のコールバックサーバーに到達しない。

## 設計方針

opencodeの実装を参考に、**OAuth 2.0 Device Authorization Grant (RFC 8628)** を追加する。既存のブラウザフローは維持しつつ、リモート環境では自動的にDevice Code Flowにフォールバックする。

## OpenAI Device Code Flow API

OpenAIは以下のエンドポイントを提供している（Codex CLIのRust実装 `codex-rs/login/src/device_code_auth.rs` から確認済み）:

| エンドポイント | URL |
|---|---|
| デバイスコード要求 | `POST https://auth.openai.com/api/accounts/deviceauth/usercode` |
| トークンポーリング | `POST https://auth.openai.com/api/accounts/deviceauth/token` |
| ユーザー認証ページ | `https://auth.openai.com/codex/device` |
| トークン交換 | `POST https://auth.openai.com/oauth/token` |

**フロー**:
1. CLIがデバイスコードを要求 → `user_code` (例: `ABCD-EFGH`) と `device_auth_id` を取得
2. ユーザーに認証URL (`https://auth.openai.com/codex/device`) とコードを表示
3. ユーザーが**任意のデバイス**のブラウザで認証URLを開き、コードを入力
4. CLIがポーリングで認証完了を待機 (5秒間隔、15分タイムアウト)
5. 認証完了後、`authorization_code` + `code_verifier` を受け取り、トークンに交換

**前提条件**: ユーザーがChatGPTアカウント設定で **"Device code authentication for Codex"** を有効化していること。未有効化の場合 `/deviceauth/usercode` が 404 を返す。

---

## 変更対象ファイル

### 1. `src/integrations/openai-codex/oauth.ts` — Device Code Flow コアロジック追加

既存の `OPENAI_CODEX_OAUTH_CONFIG` と同列にDevice Code専用の設定を追加。既存コードは一切変更しない。

**追加する設定定数:**
```typescript
export const OPENAI_CODEX_DEVICE_AUTH_CONFIG = {
  deviceCodeEndpoint: "https://auth.openai.com/api/accounts/deviceauth/usercode",
  deviceTokenEndpoint: "https://auth.openai.com/api/accounts/deviceauth/token",
  verificationUrl: "https://auth.openai.com/codex/device",
  // Device Code Flowでは、tokenの交換時に通常のlocalhostではなくこのredirect_uriを使う
  deviceCallbackRedirectUri: "https://auth.openai.com/deviceauth/callback",
  pollingIntervalMs: 5000,
  timeoutMs: 15 * 60 * 1000, // 15 minutes
} as const
```

**追加するスキーマ・型:**
```typescript
// デバイスコード要求のレスポンス
const deviceCodeResponseSchema = z.object({
  device_auth_id: z.string(),
  user_code: z.string(),
  interval: z.number().optional(), // ポーリング間隔(秒), デフォルト5秒
})
export type DeviceCodeResponse = z.infer<typeof deviceCodeResponseSchema>

// ポーリング成功レスポンス (サーバーがPKCEパラメータを生成して返す)
const deviceTokenResponseSchema = z.object({
  authorization_code: z.string(),
  code_challenge: z.string(),
  code_verifier: z.string(),
})
```

**追加する関数 (3つ):**

```typescript
/**
 * デバイスコードを要求する
 * POST /api/accounts/deviceauth/usercode
 */
export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const response = await fetch(OPENAI_CODEX_DEVICE_AUTH_CONFIG.deviceCodeEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: OPENAI_CODEX_OAUTH_CONFIG.clientId }),
    signal: AbortSignal.timeout(30000),
  })
  if (response.status === 404) {
    throw new Error(
      "Device code authentication is not enabled for your account. " +
      "Enable 'Device code authentication for Codex' in your ChatGPT security settings."
    )
  }
  if (!response.ok) {
    throw new Error(`Device code request failed: ${response.status} ${response.statusText}`)
  }
  return deviceCodeResponseSchema.parse(await response.json())
}

/**
 * ポーリングでユーザーの認証完了を待ち、credentialsを返す
 * POST /api/accounts/deviceauth/token → 成功したら /oauth/token でトークン交換
 */
export async function pollForDeviceAuthorization(
  deviceAuthId: string,
  userCode: string,
  options?: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal }
): Promise<OpenAiCodexCredentials> {
  const intervalMs = options?.intervalMs ?? OPENAI_CODEX_DEVICE_AUTH_CONFIG.pollingIntervalMs
  const timeoutMs = options?.timeoutMs ?? OPENAI_CODEX_DEVICE_AUTH_CONFIG.timeoutMs
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    options?.signal?.throwIfAborted()
    await new Promise(resolve => setTimeout(resolve, intervalMs))

    const response = await fetch(OPENAI_CODEX_DEVICE_AUTH_CONFIG.deviceTokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
      signal: options?.signal,
    })

    // 403/404 = ユーザーがまだ認証していない → ポーリング継続
    if (response.status === 403 || response.status === 404) continue
    if (!response.ok) {
      throw new Error(`Device token polling failed: ${response.status}`)
    }

    // 成功: authorization_code + code_verifier を取得
    const result = deviceTokenResponseSchema.parse(await response.json())
    return exchangeDeviceCodeForTokens(result.authorization_code, result.code_verifier)
  }
  throw new Error("Device code authentication timed out (15 minutes)")
}

/**
 * Device Code Flow用のトークン交換
 * 通常のOAuth code exchangeとredirect_uriだけが異なる
 */
async function exchangeDeviceCodeForTokens(
  authorizationCode: string,
  codeVerifier: string
): Promise<OpenAiCodexCredentials> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: OPENAI_CODEX_OAUTH_CONFIG.clientId,
    code: authorizationCode,
    redirect_uri: OPENAI_CODEX_DEVICE_AUTH_CONFIG.deviceCallbackRedirectUri,
    code_verifier: codeVerifier,
  })
  // 以降は既存の exchangeCodeForTokens() と同じトークンパース処理
  // (既存関数はredirect_uriがハードコードされているので、内部で新関数を使う)
}
```

**OpenAiCodexOAuthManager クラスへの追加:**
```typescript
class OpenAiCodexOAuthManager {
  // === 既存メソッド (変更なし) ===
  // startAuthorizationFlow(), waitForCallback(), cancelAuthorizationFlow(), etc.

  // === 新規: Device Code Flow ===
  private deviceCodeAbortController: AbortController | null = null

  /**
   * Device Code Flowを開始してDeviceCodeResponseを返す
   */
  async startDeviceCodeFlow(): Promise<DeviceCodeResponse> {
    this.cancelDeviceCodeFlow()
    this.deviceCodeAbortController = new AbortController()
    return requestDeviceCode()
  }

  /**
   * ポーリングで認証完了を待機し、完了したらcredentialsを保存
   */
  async waitForDeviceAuthorization(
    deviceAuthId: string,
    userCode: string
  ): Promise<OpenAiCodexCredentials> {
    if (!this.deviceCodeAbortController) {
      throw new Error("No pending device code flow")
    }
    const credentials = await pollForDeviceAuthorization(
      deviceAuthId, userCode,
      { signal: this.deviceCodeAbortController.signal }
    )
    await this.saveCredentials(credentials)
    this.deviceCodeAbortController = null
    return credentials
  }

  /**
   * Device Code Flowをキャンセル
   */
  cancelDeviceCodeFlow(): void {
    this.deviceCodeAbortController?.abort()
    this.deviceCodeAbortController = null
  }
}
```

### 2. `src/utils/env.ts` — リモート環境検出ユーティリティ追加

既存の `openExternal()`, `writeTextToClipboard()`, `readTextFromClipboard()` に加えて追加:

```typescript
/**
 * ローカルホストコールバックが到達不可能なリモート/ヘッドレス環境かどうかを検出
 *
 * CLI環境で使用する。VS Code Extension側では vscode.env.uiKind を使う。
 *
 * 検出条件:
 * - CODESPACES / GITHUB_CODESPACE_TOKEN → GitHub Codespaces
 * - REMOTE_CONTAINERS → VS Code Dev Containers
 * - SSH_CONNECTION / SSH_CLIENT / SSH_TTY → SSH接続
 */
export function isRemoteEnvironment(): boolean {
  return !!(
    process.env.CODESPACES ||
    process.env.GITHUB_CODESPACE_TOKEN ||
    process.env.REMOTE_CONTAINERS ||
    process.env.SSH_CONNECTION ||
    process.env.SSH_CLIENT ||
    process.env.SSH_TTY
  )
}
```

### 3. CLI — `cli/src/components/AuthView.tsx` 更新

**AuthStep 型に追加:**
```typescript
type AuthStep = ... | "openai_codex_device_auth"
```

**新しい state 追加:**
```typescript
const [deviceAuthUserCode, setDeviceAuthUserCode] = useState<string>("")
```

**`startOpenAiCodexAuth` を分岐させる:**
```typescript
const startOpenAiCodexAuth = useCallback(async () => {
  try {
    if (isRemoteEnvironment()) {
      // === Device Code Flow (リモート環境) ===
      setStep("openai_codex_device_auth")
      const deviceCode = await openAiCodexOAuthManager.startDeviceCodeFlow()
      setDeviceAuthUserCode(deviceCode.user_code)

      await openAiCodexOAuthManager.waitForDeviceAuthorization(
        deviceCode.device_auth_id,
        deviceCode.user_code,
      )
      // 成功
      await applyProviderConfig({ providerId: "openai-codex", controller })
      // ...既存の成功処理
    } else {
      // === 既存のブラウザフロー (ローカル環境) ===
      const authUrl = openAiCodexOAuthManager.startAuthorizationFlow()
      await openExternal(authUrl)
      await openAiCodexOAuthManager.waitForCallback()
      // ...既存の成功処理
    }
  } catch (error) {
    openAiCodexOAuthManager.cancelAuthorizationFlow()
    openAiCodexOAuthManager.cancelDeviceCodeFlow()
    setErrorMessage(error instanceof Error ? error.message : String(error))
    setStep("error")
  }
}, [controller])
```

**新しい `renderAuthContent` ケース:**
```tsx
case "openai_codex_device_auth":
  return (
    <Box flexDirection="column">
      <Text bold color="white">ChatGPT Sign-in (Remote)</Text>
      <Text> </Text>
      <Text color="white">Open this URL in any browser:</Text>
      <Text bold color={COLORS.primaryBlue}>
        https://auth.openai.com/codex/device
      </Text>
      <Text> </Text>
      <Text color="white">Enter this one-time code:</Text>
      <Text bold color="yellow">  {deviceAuthUserCode}</Text>
      <Text> </Text>
      <Box>
        <Text color={COLORS.primaryBlue}><Spinner type="dots" /></Text>
        <Text color="white"> Waiting for authorization...</Text>
      </Box>
      <Text> </Text>
      <Text color="gray">Code expires in 15 minutes.</Text>
      <Text color="gray">Requires ChatGPT Plus, Pro, or Team subscription.</Text>
      <Text> </Text>
      <Text color="gray">Esc to cancel</Text>
    </Box>
  )
```

**`canGoBack` に追加 & `goBack` にハンドラ追加:**
```typescript
case "openai_codex_device_auth":
  openAiCodexOAuthManager.cancelDeviceCodeFlow()
  setStep("menu")
  break
```

### 4. CLI — `cli/src/components/SettingsPanelContent.tsx` 更新

AuthView.tsx と同様の変更。`startCodexAuth` を分岐させる:

```typescript
const startCodexAuth = useCallback(async () => {
  try {
    setIsWaitingForCodexAuth(true)
    setCodexAuthError(null)

    if (isRemoteEnvironment()) {
      // Device Code Flow
      const deviceCode = await openAiCodexOAuthManager.startDeviceCodeFlow()
      setDeviceAuthUserCode(deviceCode.user_code) // 新規state
      await openAiCodexOAuthManager.waitForDeviceAuthorization(
        deviceCode.device_auth_id,
        deviceCode.user_code,
      )
    } else {
      // 既存のブラウザフロー
      const authUrl = openAiCodexOAuthManager.startAuthorizationFlow()
      await openExternal(authUrl)
      await openAiCodexOAuthManager.waitForCallback()
    }

    await applyProviderConfig({ providerId: "openai-codex", controller })
    setProvider("openai-codex")
    refreshModelIds()
    setIsWaitingForCodexAuth(false)
  } catch (error) {
    openAiCodexOAuthManager.cancelAuthorizationFlow()
    openAiCodexOAuthManager.cancelDeviceCodeFlow()
    setCodexAuthError(error instanceof Error ? error.message : String(error))
    setIsWaitingForCodexAuth(false)
  }
}, [controller])
```

**Codex auth待機中のUI表示を分岐:**
```tsx
// isWaitingForCodexAuth && deviceAuthUserCode → Device Code UI表示
// isWaitingForCodexAuth && !deviceAuthUserCode → 既存のブラウザ待機UI
```

### 5. VS Code Extension — `src/core/controller/account/openAiCodexSignIn.ts` 更新

VS Code Extension では `vscode.env.uiKind` でリモート検出できる (既に `extension.ts:588` で使用済み)。
ただし、`openAiCodexSignIn.ts` は Host-agnostic なので、環境変数ベースの検出を使う。

**変更後:**
```typescript
export async function openAiCodexSignIn(controller: Controller, _: EmptyRequest): Promise<Empty> {
  try {
    if (isRemoteEnvironment()) {
      // Device Code Flow
      const deviceCode = await openAiCodexOAuthManager.startDeviceCodeFlow()

      // Webview にデバイスコード情報をstateとしてポスト
      controller.openAiCodexDeviceCode = {
        userCode: deviceCode.user_code,
        verificationUrl: OPENAI_CODEX_DEVICE_AUTH_CONFIG.verificationUrl,
      }
      await controller.postStateToWebview()

      // バックグラウンドでポーリング
      openAiCodexOAuthManager
        .waitForDeviceAuthorization(deviceCode.device_auth_id, deviceCode.user_code)
        .then(async () => {
          controller.openAiCodexDeviceCode = null
          // 成功通知
          HostProvider.window.showMessage({
            type: ShowMessageType.INFORMATION,
            message: "Successfully signed in to OpenAI Codex",
          })
          await controller.postStateToWebview()
        })
        .catch((error) => {
          controller.openAiCodexDeviceCode = null
          // エラー処理
          openAiCodexOAuthManager.cancelDeviceCodeFlow()
          const errorMessage = error instanceof Error ? error.message : String(error)
          if (!errorMessage.includes("timed out")) {
            HostProvider.window.showMessage({
              type: ShowMessageType.ERROR,
              message: `OpenAI Codex sign in failed: ${errorMessage}`,
            })
          }
          controller.postStateToWebview()
        })
    } else {
      // 既存のブラウザフロー (変更なし)
      const authUrl = openAiCodexOAuthManager.startAuthorizationFlow()
      await openExternal(authUrl)
      openAiCodexOAuthManager.waitForCallback()...
    }
  } catch (error) {
    // ...
  }
  return {}
}
```

### 6. ExtensionState にフィールド追加

**`src/shared/ExtensionMessage.ts`:**
```typescript
interface ExtensionState {
  // ... 既存フィールド
  openAiCodexIsAuthenticated?: boolean  // 既存
  // 新規: Device Code Flow のUI表示用
  openAiCodexDeviceCode?: {
    userCode: string
    verificationUrl: string
  } | null
}
```

**`src/core/controller/index.ts` の `getStateToPostToWebview()` に追加:**
```typescript
openAiCodexDeviceCode: this.openAiCodexDeviceCode ?? null,
```

### 7. Webview — `OpenAiCodexProvider.tsx` 更新

```tsx
export const OpenAiCodexProvider = ({ showModelOptions, isPopup, currentMode }) => {
  const { apiConfiguration, openAiCodexIsAuthenticated, openAiCodexDeviceCode } = useExtensionState()
  // ...

  return (
    <div>
      <div style={{ marginBottom: "15px" }}>
        {openAiCodexIsAuthenticated ? (
          // 既存の認証済みUI
        ) : openAiCodexDeviceCode ? (
          // Device Code Flow待機中UI
          <div>
            <p style={{ fontSize: "12px", color: "var(--vscode-descriptionForeground)", marginBottom: "10px" }}>
              Open this URL in any browser and enter the code below:
            </p>
            <p style={{ marginBottom: "8px" }}>
              <a href={openAiCodexDeviceCode.verificationUrl}>
                {openAiCodexDeviceCode.verificationUrl}
              </a>
            </p>
            <p style={{
              fontSize: "18px",
              fontWeight: "bold",
              letterSpacing: "2px",
              fontFamily: "monospace",
              marginBottom: "10px"
            }}>
              {openAiCodexDeviceCode.userCode}
            </p>
            <p style={{ fontSize: "12px", color: "var(--vscode-descriptionForeground)" }}>
              Waiting for authorization... (code expires in 15 minutes)
            </p>
          </div>
        ) : (
          // 既存の未認証UI (Sign in ボタン)
        )}
      </div>
      {/* ...model options */}
    </div>
  )
}
```

### 8. `webview-ui/src/context/ExtensionStateContext.tsx` — デフォルト値追加

```typescript
openAiCodexDeviceCode: null,
```

---

## フロー図

```
ユーザーがサインイン開始
        │
        ▼
  リモート環境か？ ─── No ──→ 既存のブラウザフロー
  (env vars /            (localhost:1455 callback)
   uiKind check)
        │
       Yes
        │
        ▼
  Device Code要求
  POST /api/accounts/deviceauth/usercode
  Body: { client_id: "app_EMoamEEZ73f0CkXaXp7hrann" }
        │
        ├─ 404 → "Device code auth not enabled" エラー表示
        │
        ▼ (200)
  user_code + device_auth_id 取得
        │
        ▼
  UI表示 (CLI: React Ink / VS Code: Webview)
  ┌─────────────────────────────────────────┐
  │ Open this URL in any browser:           │
  │   https://auth.openai.com/codex/device  │
  │                                         │
  │ Enter this one-time code:               │
  │   ABCD-EFGH                             │
  │                                         │
  │ ⠋ Waiting for authorization...          │
  │                                         │
  │ Code expires in 15 minutes.             │
  └─────────────────────────────────────────┘
        │
        ▼
  ポーリング開始 ◄─────────────────┐
  POST /api/accounts/deviceauth/token
  Body: { device_auth_id, user_code }
        │                             │
        ▼                             │
  認証済み？ ─── No (403/404) ────────┘
        │          5秒待機
       Yes (200)
        │
        ▼
  authorization_code + code_verifier 取得
  (サーバーがPKCEパラメータを生成)
        │
        ▼
  トークン交換
  POST /oauth/token
  Body: {
    grant_type: "authorization_code",
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    code: <authorization_code>,
    redirect_uri: "https://auth.openai.com/deviceauth/callback",
    code_verifier: <code_verifier>
  }
        │
        ▼
  access_token + refresh_token + id_token 取得
  → accountId抽出 (JWT claims)
  → credentials保存
  → 認証完了
```

---

## 影響範囲と変更量のサマリ

| ファイル | 変更種別 | 影響度 |
|---|---|---|
| `src/integrations/openai-codex/oauth.ts` | 関数追加 + Manager拡張 | **大** (コア) |
| `src/utils/env.ts` | 関数1個追加 | 小 |
| `cli/src/components/AuthView.tsx` | ステップ追加 + 分岐 | 中 |
| `cli/src/components/SettingsPanelContent.tsx` | 分岐追加 | 中 |
| `src/core/controller/account/openAiCodexSignIn.ts` | 分岐追加 | 中 |
| `src/shared/ExtensionMessage.ts` | フィールド1個追加 | 小 |
| `src/core/controller/index.ts` | state追加 | 小 |
| `webview-ui/src/components/settings/providers/OpenAiCodexProvider.tsx` | 条件分岐UI追加 | 小 |
| `webview-ui/src/context/ExtensionStateContext.tsx` | デフォルト値追加 | 小 |

**Proto変更は不要** — Device Code情報はExtensionStateの一部としてWebviewに送るため、新規RPCは不要。既存の `postStateToWebview()` パイプラインを使う。

---

## opencode との比較

| 項目 | opencode | この設計 |
|---|---|---|
| フロー選択 | 手動 (`--device-auth` フラグ) | **自動検出** (環境変数) + 手動フォールバック可 |
| UI表示 | コンソールテキスト出力 | React Ink コンポーネント (CLI) / Webview (VS Code Extension) |
| エラー案内 | 最小限 | Device Code未有効化時の設定案内メッセージ付き |
| VS Code対応 | なし (CLIのみ) | Webview内にDevice Code UI表示 |
| キャンセル | Ctrl+C | Escキーで安全にキャンセル (AbortController使用) |
| ポーリング | 15分タイムアウト | 同じ (OpenAI API仕様に準拠) |
| トークン保存 | `~/.local/share/opencode/auth.json` | VS Code SecretStorage / StateManager |
