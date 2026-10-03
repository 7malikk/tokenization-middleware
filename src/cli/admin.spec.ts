import { AdminError, parseScopes } from './admin';
import { COMMANDS } from './main';

describe('admin CLI', () => {
  it('parses scopes case-insensitively and removes duplicates', () => {
    expect(parseScopes('tokenize, DETOKENIZE,TOKENIZE')).toEqual(['TOKENIZE', 'DETOKENIZE']);
  });

  it('rejects empty and unknown scopes', () => {
    expect(() => parseScopes(' , ')).toThrow(AdminError);
    expect(() => parseScopes('TOKENIZE,DELETE')).toThrow('unknown scope');
  });

  it('has exactly create and revoke commands, and no delete', () => {
    expect(Object.keys(COMMANDS).sort()).toEqual(['app:create', 'cred:create', 'cred:revoke']);
    const scripts = Object.entries(require('../../package.json').scripts as Record<string, string>);
    expect(scripts.filter(([name, cmd]) => /delete|remove|drop|purge/i.test(name + cmd))).toEqual([]);
  });
});
