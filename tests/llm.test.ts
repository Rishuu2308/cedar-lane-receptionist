import { describe, expect, it } from 'vitest';
import { parseJsonLoosely } from '../src/llm.js';

describe('parseJsonLoosely', () => {
  it('handles plain, fenced and prose-wrapped JSON', () => {
    expect(parseJsonLoosely('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoosely('```\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoosely('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoosely('Here you go: {"a":1} Hope that helps.')).toEqual({ a: 1 });
    expect(() => parseJsonLoosely('no json here')).toThrow();
  });
});
