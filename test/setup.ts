// Waiting between throttled attempts is real time in production; tests skip it.
jest.mock('n8n-workflow', () => ({
	...jest.requireActual('n8n-workflow'),
	sleep: jest.fn().mockResolvedValue(undefined),
}));
