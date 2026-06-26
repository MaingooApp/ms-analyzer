import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.(spec|e2e-spec)\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest'
  },
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/$1'
  },
  collectCoverageFrom: ['**/*.{t,s}?(s)'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node'
};

export default config;
