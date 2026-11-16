'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { clearOpenCodeModelsCache, loadOpenCodeModels, parseOpenCodeModels } =
  loadTs('src/main/modelCatalog.ts');
const renderer = loadTs('src/renderer/src/store/config.ts');

test.afterEach(() => {
  clearOpenCodeModelsCache();
  renderer.clearLocalOpenCodeModels();
  renderer.applyRemoteModelCatalog(null);
});

test('parses provider/model lines and deduplicates valid slugs', () => {
  assert.deepEqual(
    parseOpenCodeModels(
      [
        'anthropic/claude-sonnet-4-5',
        'openai/gpt-6-sol',
        'openrouter/anthropic/claude-sonnet-4.5',
        'openrouter/~openai/gpt-sol-latest',
        'openai/gpt-6-sol'
      ].join('\n')
    ),
    [
      {
        id: 'anthropic/claude-sonnet-4-5',
        label: 'anthropic/claude-sonnet-4-5'
      },
      { id: 'openai/gpt-6-sol', label: 'openai/gpt-6-sol' },
      {
        id: 'openrouter/anthropic/claude-sonnet-4.5',
        label: 'openrouter/anthropic/claude-sonnet-4.5'
      },
      {
        id: 'openrouter/~openai/gpt-sol-latest',
        label: 'openrouter/~openai/gpt-sol-latest'
      }
    ]
  );
});

test('rejects unsafe or non-slug lines and treats no valid output as unavailable', () => {
  assert.equal(
    parseOpenCodeModels(
      [
        '--dangerously-skip-permissions',
        'openai/gpt-6-sol --dangerously-skip-permissions',
        'openai/../etc/passwd',
        'openai/gpt-6-sol\u0000',
        'OpenCode Models:'
      ].join('\n')
    ),
    null
  );
});

test('returns current CLI models and exposes them to the OpenCode picker only', async () => {
  const models = await loadOpenCodeModels({
    run: async () => 'openai/gpt-6-sol\nanthropic/claude-sonnet-4-5'
  });
  assert.ok(renderer.applyLocalOpenCodeModels(models));
  assert.deepEqual(renderer.modelsForProvider('opencode'), [
    { label: 'CLI default' },
    { id: 'openai/gpt-6-sol', label: 'openai/gpt-6-sol' },
    { id: 'anthropic/claude-sonnet-4-5', label: 'anthropic/claude-sonnet-4-5' }
  ]);
  assert.equal(
    renderer
      .modelsForProvider('codex')
      .some((model) => model.id === 'openai/gpt-6-sol'),
    false
  );
});

test('missing executable, CLI errors, timeout and invalid output preserve curated fallback', async () => {
  const curated = renderer.modelsForProvider('opencode');
  for (const run of [
    async () => {
      throw new Error('ENOENT');
    },
    async () => {
      throw new Error('process timed out');
    },
    async () => ''
  ]) {
    assert.equal(await loadOpenCodeModels({ force: true, run }), null);
    assert.equal(renderer.applyLocalOpenCodeModels(null), false);
    assert.deepEqual(renderer.modelsForProvider('opencode'), curated);
  }
});

test('a failed refresh preserves the last good local list and cache avoids repeated CLI calls', async () => {
  let calls = 0;
  const first = await loadOpenCodeModels({
    run: async () => {
      calls++;
      return 'openai/gpt-6-sol';
    },
    now: () => 1000
  });
  assert.equal(
    await loadOpenCodeModels({
      run: async () => {
        calls++;
        throw new Error('offline');
      },
      now: () => 2000
    }).then((models) => models[0].id),
    'openai/gpt-6-sol'
  );
  assert.equal(calls, 1);
  assert.ok(renderer.applyLocalOpenCodeModels(first));
  assert.equal(
    await loadOpenCodeModels({
      force: true,
      run: async () => {
        throw new Error('timeout');
      }
    }),
    null
  );
  assert.equal(renderer.applyLocalOpenCodeModels(null), false);
  assert.deepEqual(renderer.modelsForProvider('opencode'), [
    { label: 'CLI default' },
    { id: 'openai/gpt-6-sol', label: 'openai/gpt-6-sol' }
  ]);
});
