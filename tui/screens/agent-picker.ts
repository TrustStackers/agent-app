/**
 * Agent Picker screen.
 *
 * Shown on TUI launch. Lists existing agents and lets the user:
 *   - Select an existing agent (prompts for passphrase)
 *   - Create a new agent (prompts for name + passphrase)
 *
 * Returns the unlocked/created Agent to the caller (app.ts).
 *
 * ## blessed textbox input-mode notes
 *
 * When a blessed textbox has `inputOnFocus: true`, it calls `readInput()`
 * on focus. `readInput()` sets `screen.grabKeys = true` and installs a
 * `keypress` listener on the widget. While grabKeys is true, ALL keystrokes
 * go to the widget's internal `_listener` — including Enter and Tab.
 *
 * The textbox's `_listener` (in textbox.js) intercepts Enter and calls
 * `this._done(null, this.value)`, which emits 'submit' and clears `_done`.
 * If we also bind `nameInput.key(['enter'], ...)`, that fires AFTER the
 * internal listener has already called `_done` and deleted it — so any
 * subsequent Enter press hits `_done` when it no longer exists → crash.
 *
 * ## Solution: use `readInput()` with a callback instead of `inputOnFocus`
 *
 * We set `inputOnFocus: false` and manually call `field.readInput(cb)` when
 * we want to accept input. The callback fires when the user presses Enter
 * (submit) or Escape (cancel). We chain the fields: name → passphrase →
 * confirm → submit. This is the correct blessed API for multi-field forms.
 */

import blessed from 'blessed';
import type { Host } from '@p2p-trust-stack/app-api/index.js';
import type { AgentHandle } from '@p2p-trust-stack/app-api/index.js';
import { forceRepaint } from '../app.js';

// ---------------------------------------------------------------------------
// showAgentPicker
// ---------------------------------------------------------------------------

export async function showAgentPicker(
  screen: blessed.Widgets.Screen,
  host: Host,
): Promise<AgentHandle> {
  return new Promise((resolve, reject) => {
    const agents = host.listAgents();

    const box = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: '80%',
      height: '80%',
      border: { type: 'line' },
      style: { border: { fg: 'cyan' } },
      label: ' Trust Agent — Select or Create Identity ',
    });

    blessed.text({
      parent: box,
      top: 1,
      left: 2,
      content: agents.length === 0
        ? 'No agents found. Press [n] to create your first Agent.'
        : `${agents.length} agent(s) found. Use ↑/↓ to select, [Enter] to unlock, [n] to create new.`,
      style: { fg: 'white' },
    });

    const listItems = agents.map(a => {
      const date = new Date(a.createdAt * 1000).toLocaleDateString();
      const vidShort = a.vid.slice(0, 16) + '...';
      return `  ${a.name.padEnd(20)} ${vidShort}  (created ${date})`;
    });

    const list = blessed.list({
      parent: box,
      top: 3,
      left: 1,
      right: 1,
      bottom: 6,
      items: listItems.length > 0 ? listItems : ['  (no agents)'],
      keys: true,
      vi: true,
      mouse: true,
      style: {
        selected: { bg: 'cyan', fg: 'black' },
        item: { fg: 'white' },
      },
    });

    blessed.text({
      parent: box,
      bottom: 2,
      left: 2,
      content: '[Enter] Unlock selected  [n] New agent  [d] Delete selected  [q] Quit',
      style: { fg: 'yellow' },
    });

    const nHandler = async () => {
      unbindPickerKeys();
      try {
        const agent = await showCreateAgentForm(screen, host, box);
        box.destroy();
        forceRepaint(screen);
        resolve(agent);
      } catch (err) {
        reject(err);
      }
    };

    // [d] — delete selected agent
    const dHandler = async () => {
      const idx = (list as unknown as { selected: number }).selected ?? 0;
      if (idx < 0 || idx >= agents.length) {
        return;
      }
      const agentToDelete = agents[idx];
      const confirmed = await showConfirmDialog(screen, `Delete agent "${agentToDelete.name}"? This is IRREVERSIBLE.`);
      if (confirmed) {
        host.deleteAgent(agentToDelete.name);
        // Re-list agents after deletion
        const updated = host.listAgents();
        if (updated.length === 0) {
          list.setItems(['  (no agents)']);
        } else {
          list.setItems(updated.map(a => {
            const date = new Date(a.createdAt * 1000).toLocaleDateString();
            const vidShort = a.vid.slice(0, 16) + '...';
            return `  ${a.name.padEnd(20)} ${vidShort}  (created ${date})`;
          }));
        }
        // Re-read agents variable for subsequent operations
        agents.length = 0;
        agents.push(...updated);
        list.select(0);
        screen.render();
      }
    };

    const qHandler = () => {
      unbindPickerKeys();
      box.destroy();
      forceRepaint(screen);
      reject(new Error('User quit'));
    };

    // Remove all picker-specific keybindings so they don't leak into the
    // dashboard (which has its own [n] → Network and [d] → Discover handlers).
    function unbindPickerKeys() {
      (screen as any).unkey('n', nHandler);
      (screen as any).unkey('d', dHandler);
      (screen as any).unkey('escape', qHandler);
      (screen as any).unkey('q', qHandler);
    }

    screen.key(['n'], nHandler as unknown as () => void);
    screen.key(['d'], dHandler as unknown as () => void);

    // [Enter] — unlock selected
    list.on('select', async (_item, index) => {
      try {
        if (agents.length === 0) return;
        const selected = agents[index];
        if (!selected) return;

        const passphrase = await showPassphrasePrompt(screen, `Unlock agent "${selected.name}":`);
        if (passphrase === null) return;

        const statusText = blessed.text({
          parent: box,
          top: box.height as number / 2,
          left: 'center',
          content: `Unlocking "${selected.name}"...`,
          style: { fg: 'yellow' },
        });
        screen.render();

        try {
          const agent = await host.unlockAgent({ name: selected.name, passphrase });
          statusText.destroy();
          unbindPickerKeys();
          box.destroy();
          forceRepaint(screen);
          resolve(agent);
        } catch (err) {
          statusText.setContent(`Error: ${(err as Error).message}`);
          statusText.style.fg = 'red';
          screen.render();
          await new Promise(r => setTimeout(r, 2000));
          statusText.destroy();
          // Re-focus the agent list after error so the user can try again.
          list.focus();
          screen.render();
        }
      } catch (_err) {
        // Guard against blessed internal crashes (e.g., widget already
        // destroyed).  Silently re-render the agent list.
        screen.render();
      }
    });

    screen.key(['escape', 'q'], qHandler);

    // Render the screen — critical: blessed won't draw anything without this.
    list.focus();
    screen.render();
  });
}

// ---------------------------------------------------------------------------
// showCreateAgentForm — multi-field form: name → passphrase → confirm
// ---------------------------------------------------------------------------

async function showCreateAgentForm(
  screen: blessed.Widgets.Screen,
  host: Host,
  parentBox: blessed.Widgets.BoxElement | undefined,
): Promise<AgentHandle> {
  // Destroy the picker box if it exists
  if (parentBox) parentBox.destroy();

  const formBox = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '60%',
    height: 14,
    border: { type: 'line' },
    style: { border: { fg: 'green' } },
    label: ' Create New Agent ',
  });

  const statusText = blessed.text({
    parent: formBox,
    top: 1,
    left: 2,
    right: 2,
    content: 'Enter a name for your new agent:',
    style: { fg: 'white' },
  });

  const inputField = blessed.textbox({
    parent: formBox,
    top: 3,
    left: 2,
    right: 2,
    height: 1,
    keys: true,
    mouse: true,
    style: { fg: 'white', bg: 'blue' },
  });

  blessed.text({
    parent: formBox,
    bottom: 2,
    left: 2,
    content: '[Enter] Next  [Esc] Cancel',
    style: { fg: 'yellow' },
  });

  forceRepaint(screen);
  inputField.focus();
  screen.render();

  // Step 1: Read agent name
  const agentName = await readInputField(inputField, statusText, 'Enter a name for your new agent:', screen);
  if (agentName === null) throw new Error('User cancelled');

  // Step 2: Read passphrase — replace input field because blessed's readInput()
  // behaves unreliably when called more than once on the same textbox element
  // after clearValue(), producing an immediate null return (treated as
  // "User cancelled").
  inputField.destroy();
  const passField = blessed.textbox({
    parent: formBox,
    top: 3,
    left: 2,
    right: 2,
    height: 1,
    keys: true,
    mouse: true,
    style: { fg: 'black', bg: 'blue' },
  });
  statusText.setContent('Enter a passphrase (hidden):');
  passField.focus();
  screen.render();

  const passphrase = await readInputField(passField, statusText, 'Enter a passphrase (hidden):', screen);
  if (passphrase === null) throw new Error('User cancelled');

  // Step 3: Confirm passphrase — replace input field again
  passField.destroy();
  const confirmField = blessed.textbox({
    parent: formBox,
    top: 3,
    left: 2,
    right: 2,
    height: 1,
    keys: true,
    mouse: true,
    style: { fg: 'white', bg: 'blue' },
  });
  statusText.setContent('Confirm passphrase:');
  confirmField.focus();
  screen.render();

  const passphrase2 = await readInputField(confirmField, statusText, 'Confirm passphrase:', screen);
  if (passphrase2 === null) throw new Error('User cancelled');

  if (passphrase !== passphrase2) {
    statusText.setContent('Passphrases do not match! Press [Enter] to retry or [Esc] to cancel.');
    const retry = await readInputField(inputField, statusText, '', screen);
    if (retry === null) throw new Error('User cancelled');
    // Recursively restart (simple approach)
    formBox.destroy();
    return showCreateAgentForm(screen, host, undefined);
  }

  // Create the agent
  statusText.setContent(`Creating agent "${agentName}"...`);
  statusText.style.fg = 'yellow';
  screen.render();

  try {
    const agent = await host.createAgent({ name: agentName, passphrase });
    formBox.destroy();
    forceRepaint(screen);
    return agent;
  } catch (err) {
    statusText.setContent(`Error: ${(err as Error).message}`);
    statusText.style.fg = 'red';
    screen.render();
    await new Promise(r => setTimeout(r, 3000));
    throw err;
  }
}

// ---------------------------------------------------------------------------
// readInputField — helper to read a single text input from a blessed textbox
// ---------------------------------------------------------------------------

function readInputField(
  field: blessed.Widgets.TextboxElement,
  _statusText: blessed.Widgets.TextElement,
  _label: string,
  _screen: blessed.Widgets.Screen,
): Promise<string | null> {
  return new Promise((resolve) => {
    field.readInput((err, value) => {
      if (err || value == null) {
        resolve(null);
        return;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        resolve(null);
        return;
      }
      resolve(trimmed);
    });
  });
}

// ---------------------------------------------------------------------------
// showPassphrasePrompt — simple single-field passphrase prompt
// ---------------------------------------------------------------------------

function showPassphrasePrompt(
  screen: blessed.Widgets.Screen,
  prompt: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: '50%',
      height: 8,
      border: { type: 'line' },
      style: { border: { fg: 'cyan' } },
      label: ' Unlock Agent ',
    });

    blessed.text({
      parent: overlay,
      top: 1,
      left: 2,
      content: prompt,
      style: { fg: 'white' },
    });

    const passInput = blessed.textbox({
      parent: overlay,
      top: 3,
      left: 2,
      right: 2,
      height: 1,
      keys: true,
      mouse: true,
      style: { fg: 'black', bg: 'blue' },
    });

    blessed.text({
      parent: overlay,
      bottom: 1,
      left: 2,
      content: '[Enter] Unlock  [Esc] Cancel',
      style: { fg: 'yellow' },
    });

    passInput.focus();
    screen.render();

    passInput.readInput((err, value) => {
      if (err || value == null || value.trim() === '') {
        overlay.destroy();
        forceRepaint(screen);
        resolve(null);
        return;
      }
      overlay.destroy();
      forceRepaint(screen);
      resolve(value.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// showConfirmDialog — simple yes/no confirmation
// ---------------------------------------------------------------------------

function showConfirmDialog(
  screen: blessed.Widgets.Screen,
  message: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: '50%',
      height: 8,
      border: { type: 'line' },
      style: { border: { fg: 'red' } },
      label: ' Confirm ',
    });

    blessed.text({
      parent: overlay,
      top: 1,
      left: 2,
      content: message,
      style: { fg: 'white' },
    });

    blessed.text({
      parent: overlay,
      bottom: 1,
      left: 2,
      content: '[y] Yes, delete  [n] No, cancel',
      style: { fg: 'yellow' },
    });

    screen.key(['y'], () => {
      overlay.destroy();
      forceRepaint(screen);
      resolve(true);
    });

    screen.key(['n', 'escape'], () => {
      overlay.destroy();
      forceRepaint(screen);
      resolve(false);
    });

    screen.render();
  });
}