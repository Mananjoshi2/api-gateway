import { substituteEnvVars } from '../src/config/configStore';

describe('substituteEnvVars', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('replaces ${VAR} with the matching environment variable', () => {
    process.env.MOCK_USERS_HOSTPORT = 'api-gateway-mock-users:10000';
    const result = substituteEnvVars('upstream: http://${MOCK_USERS_HOSTPORT}');
    expect(result).toBe('upstream: http://api-gateway-mock-users:10000');
  });

  it('replaces multiple distinct placeholders', () => {
    process.env.A = 'foo';
    process.env.B = 'bar';
    const result = substituteEnvVars('${A} and ${B} and ${A}');
    expect(result).toBe('foo and bar and foo');
  });

  it('resolves an unset variable to an empty string rather than throwing', () => {
    delete process.env.NOT_SET;
    const result = substituteEnvVars('upstream: http://${NOT_SET}');
    expect(result).toBe('upstream: http://');
  });

  it('leaves text with no placeholders untouched', () => {
    const raw = 'tiers:\n  free:\n    requestsPerSecond: 5\n';
    expect(substituteEnvVars(raw)).toBe(raw);
  });
});
