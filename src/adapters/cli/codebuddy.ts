import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';
import { delay } from '../../utils/timing.js';

export function createCodeBuddyAdapter(pathOverride?: string): CliAdapter {
  const rawBin = pathOverride ?? 'codebuddy';
  let cachedBin: string | undefined;
  return {
    id: 'codebuddy',
    authPaths: ['~/.codebuddy'],
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    buildArgs({ sessionId, resume, resumeSessionId, workingDir, model, disableCliBypass }) {
      const args = [
        '--session-id', resume ? (resumeSessionId ?? sessionId) : sessionId,
        '--model', model?.trim() || 'hy3-ioa',
        '--effort', 'max',
        '--permission-mode', disableCliBypass ? 'default' : 'dontAsk',
      ];
      if (workingDir) args.push('--add-dir', workingDir);
      return args;
    },

    buildResumeCommand({ cliSessionId, sessionId }) {
      return `codebuddy --resume ${cliSessionId ?? sessionId}`;
    },

    async writeInput(pty: PtyHandle, content: string) {
      try {
        if (pty.pasteText) pty.pasteText(content);
        else pty.write('\x1b[200~' + content + '\x1b[201~');
        await delay(400);
        if (pty.sendSpecialKeys) pty.sendSpecialKeys('Enter');
        else pty.write('\r');
      } catch {
        return { submitted: false };
      }
      return undefined;
    },

    completionPattern: undefined,
    readyPattern: /❯|›|>/,
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: false,
    modelChoices: ['hy3-ioa'],
  };
}

export const create = createCodeBuddyAdapter;
