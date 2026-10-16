import * as React from "react";
import { Button } from "@/components/ui/button";
import { appConfig } from "@/lib/config";
import type { InputMode, OrchestratorModel } from "@/lib/contracts";
import { validateAttachments } from "@/lib/state";

export interface ReconstructRequestPayload {
  readonly input_url: string;
  readonly input_mode: InputMode;
  readonly orchestrator_model: OrchestratorModel;
  readonly deep_verify: boolean;
  readonly attachment_names: readonly string[];
}

export interface PromptBarProps {
  readonly onSubmitRun: (payload: ReconstructRequestPayload) => void;
  readonly busy: boolean;
}

export function PromptBar({ onSubmitRun, busy }: PromptBarProps): React.JSX.Element {
  const [inputUrl, setInputUrl] = React.useState<string>("");
  const [inputMode, setInputMode] = React.useState<InputMode>("link");
  const [orchestratorModel, setOrchestratorModel] =
    React.useState<OrchestratorModel>("gemini-4-argon");
  const [deepVerify, setDeepVerify] = React.useState<boolean>(true);
  const [attachments, setAttachments] = React.useState<readonly string[]>([]);
  const [attachmentError, setAttachmentError] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    const check = validateAttachments(files.map((f) => f.name), appConfig.maxAttachments);
    setAttachments(check.accepted);
    setAttachmentError(check.error ? check.error.message : null);
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (!inputUrl.trim() && attachments.length === 0) {
      return;
    }
    onSubmitRun({
      input_url: inputUrl.trim(),
      input_mode: inputMode,
      orchestrator_model: orchestratorModel,
      deep_verify: deepVerify,
      attachment_names: attachments,
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      data-testid="prompt-bar"
      className="pointer-events-auto flex w-full max-w-3xl flex-col gap-2 rounded-sm border border-hairline bg-panel/95 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Input mode"
          data-testid="input-mode-select"
          value={inputMode}
          onChange={(e) => setInputMode(e.target.value as InputMode)}
          className="h-8 rounded-sm border border-hairline bg-bg px-2 font-mono text-xs text-text focus:border-amber focus:outline-none"
        >
          <option value="link">Link</option>
          <option value="photos">Photos</option>
          <option value="drawings">Drawings</option>
          <option value="cad">CAD</option>
        </select>

        <input
          type="text"
          data-testid="product-url-input"
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          placeholder="Enter product link or specification reference..."
          aria-label="Product link"
          className="h-8 min-w-48 flex-1 rounded-sm border border-hairline bg-bg px-3 font-mono text-xs text-text placeholder:text-dim focus:border-amber focus:outline-none"
        />

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.pdf"
          multiple
          onChange={handleFileChange}
          className="hidden"
          data-testid="attachment-file-input"
        />
        <Button
          variant="outline"
          size="sm"
          data-testid="attachment-button"
          onClick={() => fileInputRef.current?.click()}
        >
          Attach ({attachments.length}/{appConfig.maxAttachments})
        </Button>

        <Button
          type="submit"
          variant="default"
          size="sm"
          disabled={busy || (!inputUrl.trim() && attachments.length === 0)}
          data-testid="reconstruct-button"
        >
          {busy ? "Reconstructing..." : "Reconstruct"}
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-2 font-mono text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-dim">
            <span>Orchestrator:</span>
            <select
              aria-label="Orchestrator model"
              data-testid="orchestrator-select"
              value={orchestratorModel}
              onChange={(e) =>
                setOrchestratorModel(e.target.value as OrchestratorModel)
              }
              className="rounded-sm border border-hairline bg-bg px-2 py-0.5 font-mono text-xs text-amber focus:border-amber focus:outline-none"
            >
              <option value="gemini-4-argon">Gemini 4 Argon</option>
              <option value="gemini-3.8-flash">Gemini 3.8 Flash</option>
            </select>
          </label>
          <span data-testid="subagent-note" className="text-dim">
            Part sub-agents: Gemini 3.8 Flash
          </span>
        </div>

        <label className="flex cursor-pointer items-center gap-1.5 text-text">
          <input
            type="checkbox"
            data-testid="deep-verify-toggle"
            checked={deepVerify}
            onChange={(e) => setDeepVerify(e.target.checked)}
            className="accent-amber"
          />
          <span>Deep Verify</span>
        </label>
      </div>

      {attachmentError && (
        <p data-testid="attachment-validation-note" className="font-mono text-xs text-danger">
          {attachmentError}
        </p>
      )}
      <p
        data-testid="thesis-line"
        className="text-center font-mono text-xs text-dim"
      >
        Can Gemini 4 Argon make the physical world safer?
      </p>
    </form>
  );
}
