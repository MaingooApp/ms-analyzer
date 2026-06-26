import { parseAzureTokenUsage } from './azure-docintelligence.service';

describe('parseAzureTokenUsage', () => {
  it('parses the Azure usage shape from Content Understanding', () => {
    expect(
      parseAzureTokenUsage({
        documentPagesStandard: 2,
        contextualizationTokens: 2000,
        tokens: {
          'gpt-4.1-input': 23189,
          'gpt-4.1-output': 5266,
        },
      }),
    ).toEqual({
      documentPagesStandard: 2,
      contextualizationTokens: 2000,
      rawUsage: {
        documentPagesStandard: 2,
        contextualizationTokens: 2000,
        tokens: {
          'gpt-4.1-input': 23189,
          'gpt-4.1-output': 5266,
        },
      },
      entries: [
        {
          model: 'gpt-4.1',
          inputTokens: 23189,
          outputTokens: 5266,
          totalTokens: 28455,
        },
      ],
    });
  });

  it('groups input and output tokens by model', () => {
    const usage = parseAzureTokenUsage({
      tokens: {
        'gpt-4.1-input': 10,
        'gpt-4.1-output': 2,
        'gpt-4.1-mini-input': 5,
        'gpt-4.1-mini-output': 1,
        ignored: 100,
      },
    });

    expect(usage?.entries).toEqual([
      { model: 'gpt-4.1', inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      { model: 'gpt-4.1-mini', inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    ]);
  });
});
