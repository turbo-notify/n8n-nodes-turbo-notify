/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
	preset: 'ts-jest',
	testEnvironment: 'node',
	roots: ['<rootDir>/test'],
	setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
	testMatch: ['**/*.test.ts', '**/*.test.js'],
	transform: {
		'^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/test/tsconfig.json', diagnostics: true }],
	},
};
