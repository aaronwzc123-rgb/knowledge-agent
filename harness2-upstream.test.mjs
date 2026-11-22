import assert from 'node:assert/strict';
import test from 'node:test';
import { upstreamHarness2Arguments, upstreamHarness2Info } from './harness2-upstream.mjs';

test('the upstream launcher exposes every official entry point and preserves arguments verbatim', () => {
  const commands = Object.keys(upstreamHarness2Info().commands);
  assert.deepEqual(commands.filter(command => command.startsWith('harness2')).sort(), [
    'harness2', 'harness2-bridge', 'harness2-check', 'harness2-demo', 'harness2-judge', 'harness2-report', 'harness2-setup',
  ]);
  const args = ['--bench', 'wb', '--subset', 'office', '--substrate', 'cx', '--mode',
    'parallel,sequential', '--k', '7', '--split-file', 'two words.json', '--dry-run'];
  const invocation = upstreamHarness2Arguments({ command: 'harness2', args });
  assert.deepEqual(invocation.args.slice(-args.length), args);
  assert.equal(invocation.args.at(-args.length - 1), 'harness2.cli.run_sweep');
  assert.throws(() => upstreamHarness2Arguments({ command: 'sh', args: [] }), { status: 400 });
});
