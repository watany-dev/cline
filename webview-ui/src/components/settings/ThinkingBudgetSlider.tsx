import { memo, useCallback, useState, useEffect, useMemo } from "react"
import {
	AnthropicModelId,
	anthropicDefaultModelId,
	anthropicModels,
	ApiConfiguration,
	BedrockModelId,
	bedrockDefaultModelId,
	bedrockModels,
	GeminiModelId,
	geminiDefaultModelId,
	geminiModels,
	ModelInfo,
	VertexModelId,
	vertexDefaultModelId,
	vertexModels,
} from "@shared/api"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import styled from "styled-components"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useApiConfigurationHandlers } from "./utils/useApiConfigurationHandlers"
import { getModeSpecificFields } from "./utils/providerUtils"
import { Mode } from "@shared/storage/types"

// Constants
const DEFAULT_MIN_VALID_TOKENS = 1024
const DEFAULT_MAX_PERCENTAGE = 0.8
const MAX_PERCENTAGE = 0.8
const THUMB_SIZE = 16

// Styled Components
const Container = styled.div`
	display: flex;
	flex-direction: column;
	gap: 10px;
`

const LabelContainer = styled.div`
	display: flex;
	justify-content: space-between;
	flex-wrap: wrap;
	gap: 12px;
`

const Label = styled.label`
	font-weight: 500;
	display: block;
	margin-right: auto;
`

const Description = styled.p`
	font-size: 12px;
	margin-top: 0px;
	margin-bottom: 0px;
	color: var(--vscode-descriptionForeground);
`

const RangeInput = styled.input<{ $value: number; $min: number; $max: number }>`
	width: 100%;
	height: 8px;
	appearance: none;
	border-radius: 4px;
	outline: none;
	cursor: pointer;
	margin: 5px 0 0;
	padding: 0;
	background: ${(props) => {
		const percentage = ((props.$value - props.$min) / (props.$max - props.$min)) * 100
		return `linear-gradient(to right, 
      var(--vscode-progressBar-background) 0%,
      var(--vscode-progressBar-background) ${percentage}%,
      var(--vscode-scrollbarSlider-background) ${percentage}%,
      var(--vscode-scrollbarSlider-background) 100%)`
	}};

	&::-webkit-slider-thumb {
		appearance: none;
		width: ${THUMB_SIZE}px;
		height: ${THUMB_SIZE}px;
		border-radius: 50%;
		background: var(--vscode-foreground);
		cursor: pointer;
		border: 0px solid var(--vscode-progressBar-background);
		box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
	}

	&:focus {
		outline: none;
	}

	&:focus::-webkit-slider-thumb,
	&:hover::-webkit-slider-thumb {
		border-color: var(--vscode-progressBar-background);
		box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
	}

	&:active::-webkit-slider-thumb {
		outline: none;
		border-color: var(--vscode-progressBar-background);
	}
`

interface ThinkingBudgetSliderProps {
	maxBudget?: number
	currentMode: Mode
}

const ThinkingBudgetSlider = ({ maxBudget, currentMode }: ThinkingBudgetSliderProps) => {
	const { apiConfiguration } = useExtensionState()
	const { handleModeFieldChange } = useApiConfigurationHandlers()

	const modeFields = getModeSpecificFields(apiConfiguration, currentMode)

	const [isEnabled, setIsEnabled] = useState<boolean>((modeFields.thinkingBudgetTokens || 0) > 0)

	const getModelInfo = (provider?: string, modelId?: string): ModelInfo | undefined => {
		if (!provider || !modelId) return undefined

		switch (provider) {
			case "vertex":
				return modelId in vertexModels ? vertexModels[modelId as VertexModelId] : undefined
			case "gemini":
				return modelId in geminiModels ? geminiModels[modelId as GeminiModelId] : undefined
			case "anthropic":
				return modelId in anthropicModels ? anthropicModels[modelId as AnthropicModelId] : undefined
			case "bedrock":
				return modelId in bedrockModels ? bedrockModels[modelId as BedrockModelId] : undefined
			default:
				return undefined
		}
	}

	const getModelThinkingConfig = (): { maxBudget?: number; percentage: number } => {
		const provider = modeFields.apiProvider
		const modelId = modeFields.apiModelId

		if (!provider || !modelId) {
			return { percentage: DEFAULT_MAX_PERCENTAGE }
		}

		let percentage = DEFAULT_MAX_PERCENTAGE

		if (modelId === "gemini-2.5-flash-preview-04-17") {
			percentage = 1.0
		} else if (
			modelId === "claude-3-7-sonnet-20250219" ||
			modelId === "anthropic.claude-3-7-sonnet-20250219-v1:0" ||
			modelId === "claude-3-7-sonnet@20250219"
		) {
			percentage = 0.5
		}

		const modelInfo = getModelInfo(provider, modelId)
		if (!modelInfo) {
			return {
				maxBudget:
					(provider === "anthropic" && anthropicModels["claude-3-7-sonnet-20250219"].thinkingConfig?.maxBudget) ||
					(provider === "bedrock" &&
						bedrockModels["anthropic.claude-3-7-sonnet-20250219-v1:0"].thinkingConfig?.maxBudget) ||
					(provider === "vertex" && vertexModels["claude-3-7-sonnet@20250219"].thinkingConfig?.maxBudget) ||
					(provider === "gemini" && geminiModels["gemini-2.5-flash-preview-04-17"].thinkingConfig?.maxBudget) ||
					undefined,
				percentage,
			}
		}

		return {
			maxBudget: modelInfo.thinkingConfig?.maxBudget,
			percentage,
		}
	}

	const maxTokens = useMemo(() => {
		const provider = modeFields.apiProvider
		const modelId = modeFields.apiModelId

		if (!provider || !modelId) return 0

		const modelInfo = getModelInfo(provider, modelId)

		if (modelInfo?.thinkingConfig?.maxBudget) {
			return modelInfo.thinkingConfig.maxBudget
		}

		if (modelInfo?.maxTokens) {
			return modelInfo.maxTokens
		}

		switch (provider) {
			case "vertex":
				return vertexModels[vertexDefaultModelId].maxTokens || 0
			case "gemini":
				return geminiModels[geminiDefaultModelId].maxTokens || 0
			case "anthropic":
				return anthropicModels[anthropicDefaultModelId].maxTokens || 0
			case "bedrock":
				return bedrockModels[bedrockDefaultModelId].maxTokens || 0
			default:
				return 0
		}
	}, [modeFields.apiProvider, modeFields.apiModelId])

	// use maxBudget prop if provided, otherwise apply the percentage cap to maxTokens
	const maxSliderValue = useMemo(() => {
		if (maxBudget !== undefined) {
			return maxBudget
		}

		const thinkingConfig = getModelThinkingConfig()
		if (thinkingConfig.maxBudget) {
			return Math.floor(thinkingConfig.maxBudget * thinkingConfig.percentage)
		}

		return Math.floor(maxTokens * MAX_PERCENTAGE)
	}, [maxBudget, maxTokens])

	// Add local state for the slider value
	const [localValue, setLocalValue] = useState(modeFields.thinkingBudgetTokens || 0)

	useEffect(() => {
		const { thinkingBudgetTokens } = modeFields

		if (!thinkingBudgetTokens || thinkingBudgetTokens <= 0) return

		if (thinkingBudgetTokens > maxSliderValue) {
			setLocalValue(maxSliderValue)
			handleModeFieldChange(
				{ plan: "planModeThinkingBudgetTokens", act: "actModeThinkingBudgetTokens" },
				maxSliderValue,
				currentMode,
			)
		}
	}, [modeFields.apiProvider, modeFields.apiModelId, maxSliderValue, handleModeFieldChange, currentMode])

	const handleSliderChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
		const value = parseInt(event.target.value, 10)
		setLocalValue(value)
	}, [])

	const handleSliderComplete = () => {
		handleModeFieldChange(
			{ plan: "planModeThinkingBudgetTokens", act: "actModeThinkingBudgetTokens" },
			localValue,
			currentMode,
		)
	}

	const handleToggleChange = (event: any) => {
		const isChecked = (event.target as HTMLInputElement).checked
		const newValue = isChecked ? DEFAULT_MIN_VALID_TOKENS : 0
		setIsEnabled(isChecked)
		setLocalValue(newValue)

		handleModeFieldChange({ plan: "planModeThinkingBudgetTokens", act: "actModeThinkingBudgetTokens" }, newValue, currentMode)
	}

	return (
		<Container>
			<VSCodeCheckbox checked={isEnabled} onChange={handleToggleChange}>
				Enable extended thinking
			</VSCodeCheckbox>

			{isEnabled && (
				<>
					<LabelContainer>
						<Label htmlFor="thinking-budget-slider">
							<strong>Budget:</strong> {localValue.toLocaleString()} tokens
						</Label>
					</LabelContainer>
					<RangeInput
						id="thinking-budget-slider"
						type="range"
						min={DEFAULT_MIN_VALID_TOKENS}
						max={maxSliderValue}
						step={1}
						value={localValue}
						onChange={handleSliderChange}
						onMouseUp={handleSliderComplete}
						onTouchEnd={handleSliderComplete}
						$value={localValue}
						$min={DEFAULT_MIN_VALID_TOKENS}
						$max={maxSliderValue}
						aria-label={`Thinking budget: ${localValue.toLocaleString()} tokens`}
						aria-valuemin={DEFAULT_MIN_VALID_TOKENS}
						aria-valuemax={maxSliderValue}
						aria-valuenow={localValue}
						aria-describedby="thinking-budget-description"
					/>

					<Description id="thinking-budget-description">
						Higher budgets may allow you to achieve more comprehensive and nuanced reasoning
					</Description>
				</>
			)}
		</Container>
	)
}

export default memo(ThinkingBudgetSlider)
