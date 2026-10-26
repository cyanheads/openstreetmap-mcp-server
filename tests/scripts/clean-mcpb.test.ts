/** @fileoverview Bundle pruning preserves SDK skill modules while excluding dependency agent docs. */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

describe('MCPB agent documentation pruning', () => {
  const entries = [
    'skills/openstreetmap-guide/SKILL.md',
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/outer/node_modules/@modelcontextprotocol/server/dist/ext/skills/loader.mjs',
    'node_modules/example/dist/skills/runtime.js',
    'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
    'node_modules/example/skills/guide/reference.md',
    'node_modules/outer/node_modules/@scope/example/skills/guide/reference.md',
    'node_modules/example/.claude/settings.json',
    'node_modules/example/.agents/guide.md',
    'node_modules/example/docs/SKILL.md',
  ];
  const documentation = [
    'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
    'node_modules/example/skills/guide/reference.md',
    'node_modules/outer/node_modules/@scope/example/skills/guide/reference.md',
    'node_modules/example/.claude/settings.json',
    'node_modules/example/.agents/guide.md',
    'node_modules/example/docs/SKILL.md',
  ];

  it('preserves runtime modules and the server guide when selecting entries to remove', () => {
    expect(filterAgentDocEntries(entries)).toEqual(documentation);
  });

  it('allows the same runtime entries through the post-bundle linter', () => {
    // The copied linter also has a framework-repo branch; load it as its CLI runtime does.
    const output = execFileSync(
      process.execPath,
      [
        '--eval',
        'import(process.argv[2]).then(({ AGENT_DOC_ENTRY }) => console.log(JSON.stringify(JSON.parse(process.argv[3]).filter(entry => AGENT_DOC_ENTRY.test(entry)))));',
        'mcpb-regression',
        new URL('../../scripts/lint-packaging.ts', import.meta.url).href,
        JSON.stringify(entries),
      ],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(output)).toEqual(documentation);
  });
});
