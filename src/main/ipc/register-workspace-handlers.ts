import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { ZodType } from 'zod';
import { z } from 'zod';
import {
  connectedSessionsSchema,
  exportRequestSchema,
  forwardRuleInputSchema,
  forwardRuleSchema,
  forwardRulesSchema,
  forwardStartRequestSchema,
  forwardStatusSchema,
  forwardStatusesSchema,
  forwardStopRequestSchema,
  historyQuerySchema,
  historySettingSchema,
  noteCreateFolderSchema,
  noteLocationIdSchema,
  noteLocationsSchema,
  notePathRequestSchema,
  noteSaveRequestSchema,
  noteSchema,
  noteSearchRequestSchema,
  noteSearchResultsSchema,
  noteSummariesSchema,
  runRequestSchema,
  runResultsSchema,
  savedSchema,
  snippetInputSchema,
  snippetSchema,
  snippetsSchema,
  type Snippet,
} from '../../shared/workspace-contract';
import { emptySshRequestSchema } from '../../shared/ssh-contract';
import type { ForwardingService } from '../ssh/forwarding-service';
import type { SshSessionManager } from '../ssh/ssh-session-manager';
import { renderSnippet, resultsToCsv, resultsToMarkdown, runOnClient } from '../ssh/snippet-runner';
import type { JsonStore } from '../storage/json-store';
import type { CommandHistory } from '../workspace/command-history';
import type { NotesService } from '../workspace/notes-service';

export interface WorkspaceServices {
  sessions: SshSessionManager;
  forwarding: ForwardingService;
  snippets: JsonStore<Snippet[]>;
  history: CommandHistory;
  notes: NotesService;
}

function handle<I, O>(
  channel: string,
  input: ZodType<I>,
  output: ZodType<O>,
  action: (request: I, window: BrowserWindow) => Promise<unknown> | unknown,
): void {
  ipcMain.handle(channel, async (event, payload: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      throw new Error('This API is only available to TunnelNote application windows.');
    }
    return output.parse(await action(input.parse(payload), window));
  });
}

export function registerWorkspaceHandlers(services: WorkspaceServices): void {
  const { sessions, forwarding, snippets, history, notes } = services;
  const empty = emptySshRequestSchema;

  handle('forward:list', empty, forwardRulesSchema, () => forwarding.list());
  handle('forward:save', forwardRuleInputSchema, forwardRuleSchema, (rule) =>
    forwarding.save(rule),
  );
  handle('forward:delete', forwardStopRequestSchema, empty, async (r) => {
    await forwarding.remove(r.ruleId);
    return {};
  });
  handle('forward:status', empty, forwardStatusesSchema, () => forwarding.statuses());
  handle('forward:start', forwardStartRequestSchema, forwardStatusSchema, (r) =>
    forwarding.start(r.ruleId, r.sessionId, r.confirmPublicBind),
  );
  handle('forward:stop', forwardStopRequestSchema, empty, (r) => {
    forwarding.stop(r.ruleId);
    return {};
  });

  handle('snippets:list', empty, snippetsSchema, () => snippets.read());
  handle('snippets:save', snippetInputSchema, snippetSchema, async (input) => {
    const saved = snippetSchema.parse({ ...input, id: input.id ?? randomUUID() });
    const all = await snippets.read();
    await snippets.write(
      all.some((s) => s.id === saved.id)
        ? all.map((s) => (s.id === saved.id ? saved : s))
        : [...all, saved],
    );
    return saved;
  });
  handle('snippets:delete', z.object({ id: z.string().uuid() }).strict(), empty, async (r) => {
    await snippets.write((await snippets.read()).filter((s) => s.id !== r.id));
    return {};
  });

  handle('runner:sessions', empty, connectedSessionsSchema, () => sessions.listConnectedSessions());
  handle('runner:run', runRequestSchema, runResultsSchema, async (request) => {
    const connected = new Map(sessions.listConnectedSessions().map((s) => [s.sessionId, s]));
    const results = await Promise.all(
      request.sessionIds.map(async (sessionId) => {
        const info = connected.get(sessionId);
        if (!info) throw new Error('A selected session is no longer connected.');
        const target = sessions.getSessionTarget(sessionId);
        const command = renderSnippet(request.command, target, request.variables);
        return runOnClient(
          sessions.getTransport(sessionId),
          sessionId,
          info.hostName,
          command,
          request.timeoutSeconds,
        );
      }),
    );
    if (request.recordHistory) history.record(results);
    return results;
  });
  handle('runner:export', exportRequestSchema, savedSchema, async (request, window) => {
    const markdown = request.format === 'markdown';
    const file = await dialog.showSaveDialog(window, {
      title: 'Export command results',
      defaultPath: markdown ? 'results.md' : 'results.csv',
    });
    if (file.canceled || !file.filePath) return { saved: false };
    await writeFile(
      file.filePath,
      markdown ? resultsToMarkdown(request.results) : resultsToCsv(request.results),
      'utf8',
    );
    return { saved: true };
  });
  handle('history:set', historySettingSchema, historySettingSchema, (r) => {
    history.setEnabled(r.enabled);
    return { enabled: history.isEnabled() };
  });
  handle('history:get', empty, historySettingSchema, () => ({ enabled: history.isEnabled() }));
  handle('history:search', historyQuerySchema, runResultsSchema, (r) => history.search(r.query));

  handle('notes:list', empty, noteSummariesSchema, () => notes.list());
  handle('notes:read', notePathRequestSchema, noteSchema, (r) => notes.read(r.path));
  handle('notes:save', noteSaveRequestSchema, noteSchema, (r) => notes.save(r));
  handle('notes:delete', notePathRequestSchema, empty, async (r) => {
    await notes.remove(r.path);
    return {};
  });
  handle('notes:search', noteSearchRequestSchema, noteSearchResultsSchema, (r) =>
    notes.search(r.query),
  );
  handle('notes:locations', empty, noteLocationsSchema, () => notes.locations());
  handle('notes:addLocation', empty, noteLocationsSchema, async (_request, window) => {
    const choice = await dialog.showOpenDialog(window, {
      title: 'Choose or create a folder for your notes',
      properties: ['openDirectory', 'createDirectory'],
    });
    const folder = choice.filePaths[0];
    return choice.canceled || !folder ? notes.locations() : notes.addLocation(folder);
  });
  handle('notes:removeLocation', noteLocationIdSchema, noteLocationsSchema, (r) =>
    notes.removeLocation(r.id),
  );
  handle('notes:createFolder', noteCreateFolderSchema, noteLocationsSchema, (r) =>
    notes.createFolder(r.location, r.name),
  );
}
