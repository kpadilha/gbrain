import { describe, expect, test } from 'bun:test';

import { dimsProviderOptions } from '../../src/core/ai/dims.ts';

describe('Jina v5 Omni asymmetric embeddings', () => {
  const model = 'jinaai/jina-embeddings-v5-omni-small';

  test('threads query/document input_type through OpenAI-compatible providers', () => {
    expect(dimsProviderOptions('openai-compatible', model, 1024, 'query')).toEqual({
      openaiCompatible: { input_type: 'query' },
    });
    expect(dimsProviderOptions('openai-compatible', model, 1024, 'document')).toEqual({
      openaiCompatible: { input_type: 'document' },
    });
  });

  test('defaults an unspecified role to document without sending a dimensions override', () => {
    expect(dimsProviderOptions('openai-compatible', model, 1024)).toEqual({
      openaiCompatible: { input_type: 'document' },
    });
  });
});
