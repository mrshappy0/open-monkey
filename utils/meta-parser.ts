export interface ScriptMeta {
  name: string;
  description: string;
  version: string;
  matches: string[];
  excludes: string[];
  runAt: 'document-start' | 'document-end' | 'document-idle';
}

const VALID_RUN_AT = ['document-start', 'document-end', 'document-idle'] as const;

export function parseMeta(code: string): ScriptMeta {
  const block =
    code.match(/\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/)?.[1] ?? '';

  const get = (key: string): string[] =>
    [...block.matchAll(new RegExp(`@${key}[ \\t]+(.+)`, 'g'))].map(m =>
      m[1].trim(),
    );

  const runAtRaw = get('run-at')[0] ?? 'document-end';
  const runAt = (
    VALID_RUN_AT.includes(runAtRaw as ScriptMeta['runAt'])
      ? runAtRaw
      : 'document-end'
  ) as ScriptMeta['runAt'];

  return {
    name: get('name')[0] ?? 'Unnamed Script',
    description: get('description')[0] ?? '',
    version: get('version')[0] ?? '1.0.0',
    matches: get('match'),
    excludes: get('exclude'),
    runAt,
  };
}

export const SCRIPT_TEMPLATE = `\
// ==UserScript==
// @name        My Script
// @description Brief description
// @version     1.0.0
// @match       https://example.com/*
// @run-at      document-end
// ==/UserScript==

(function () {
  'use strict';

  // Your code here
})();
`;
