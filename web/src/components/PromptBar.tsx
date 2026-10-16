import { ArrowUp, ChevronDown, Paperclip } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
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

const INPUT_MODES: readonly { readonly value: InputMode; readonly label: string }[] = [
  { value: "link", label: "Link" },
  { value: "photos", label: "Photos" },
  { value: "drawings", label: "Drawings" },
  { value: "cad", label: "CAD" },
];

const ORCHESTRATOR_MODELS: readonly { readonly value: OrchestratorModel; readonly label: string }[] = [
  { value: "gemini-4-argon", label: "Gemini 4 Argon" },
  { value: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
];

export function PromptBar({ onSubmitRun, busy }: PromptBarProps): React.JSX.Element {
  const [inputUrl, setInputUrl] = React.useState<string>("");
  const [inputMode, setInputMode] = React.useState<InputMode>("link");
  const [orchestratorModel, setOrchestratorModel] = React.useState<OrchestratorModel>("gemini-4-argon");
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
    if (!inputUrl.trim() && attachments.length === 0) return;
    onSubmitRun({
      input_url: inputUrl.trim(),
      input_mode: inputMode,
      orchestrator_model: orchestratorModel,
      deep_verify: deepVerify,
      attachment_names: attachments,
    });
  };

  const activeModeLabel = INPUT_MODES.find((m) => m.value === inputMode)?.label ?? "Link";
  const activeModelLabel = ORCHESTRATOR_MODELS.find((m) => m.value === orchestratorModel)?.label ?? "Gemini 4 Argon";

  return (
    <form
      onSubmit={handleSubmit}
      data-testid="prompt-bar"
      className="pointer-events-auto flex w-full max-w-3xl flex-col items-center gap-2 font-sans"
    >
      <div
        data-prompt-pill="true"
        className="flex h-14 w-full items-center gap-2 rounded-full bg-panel/95 px-3 transition-all duration-200 ease-out"
      >
        <DropdownMenu>
          <DropdownMenuTrigger aria-label="Input mode" data-testid="input-mode-select" data-value={inputMode}>
            <span>{activeModeLabel}</span>
            <ChevronDown className="h-3.5 w-3.5 text-dim" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {INPUT_MODES.map((m) => (
              <DropdownMenuItem key={m.value} active={inputMode === m.value} data-testid={`input-mode-option-${m.value}`} onClick={() => setInputMode(m.value)}>
                {m.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <input
          type="text"
          data-testid="product-url-input"
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          placeholder="Paste a product link, specification, or teardown source…"
          aria-label="Product link"
          className="h-10 min-w-32 flex-1 bg-transparent px-2 font-sans text-sm text-text caret-amber placeholder:text-dim focus:outline-none"
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
        <button
          type="button"
          data-testid="attachment-button"
          aria-label="Attach files"
          title={`Attach files (${attachments.length}/${appConfig.maxAttachments})`}
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-full bg-secondary/80 px-2.5 font-sans text-xs text-dim transition-colors duration-150 ease-out hover:bg-secondary hover:text-text"
        >
          <Paperclip className="h-3.5 w-3.5" />
          <span className="font-mono tabular-nums">{attachments.length}/{appConfig.maxAttachments}</span>
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger aria-label="Orchestrator model" data-testid="orchestrator-select" data-value={orchestratorModel} className="hidden sm:inline-flex">
            <span className="text-amber">{activeModelLabel}</span>
            <ChevronDown className="h-3.5 w-3.5 text-dim" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {ORCHESTRATOR_MODELS.map((m) => (
              <DropdownMenuItem key={m.value} active={orchestratorModel === m.value} data-testid={`orchestrator-option-${m.value}`} onClick={() => setOrchestratorModel(m.value)}>
                {m.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="hidden items-center gap-1.5 rounded-full bg-secondary/60 px-2.5 py-1 md:flex">
          <Switch data-testid="deep-verify-toggle" aria-label="Deep Verify" checked={deepVerify} onCheckedChange={setDeepVerify} />
          <span className="font-sans text-xs text-dim">Deep Verify</span>
        </div>

        <Button
          type="submit"
          variant="default"
          size="icon"
          aria-label="Reconstruct"
          disabled={busy || (!inputUrl.trim() && attachments.length === 0)}
          data-testid="reconstruct-button"
          className="h-10 w-10 shrink-0 rounded-full"
        >
          <ArrowUp className="h-4 w-4" />
          <span className="sr-only">{busy ? "Reconstructing..." : "Reconstruct"}</span>
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-4 text-xs text-dim">
        <span data-testid="subagent-note" className="font-sans">Part sub-agents: Gemini 3.8 Flash</span>
        {attachmentError && <span data-testid="attachment-validation-note" className="font-sans text-danger">{attachmentError}</span>}
      </div>
    </form>
  );
}
