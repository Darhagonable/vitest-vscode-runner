import { describe, expect, it } from 'vitest';
import { createLaunchArgs } from '../../src/external-pool.js';

describe('createLaunchArgs', () => {
  it('uses sane defaults when no options are set', () => {
    expect(createLaunchArgs({})).toEqual([
      '--disable-extensions',
      '--extensions-dir=extensions',
      '--user-data-dir=user-data'
    ]);
  });

  it('replaces defaults with user launchArgs but still pins profiles', () => {
    const args = createLaunchArgs({ launchArgs: ['--custom-flag'] });
    expect(args).toContain('--custom-flag');
    expect(args).not.toContain('--disable-extensions');
    expect(args).toContain('--extensions-dir=extensions');
    expect(args).toContain('--user-data-dir=user-data');
  });

  it.each([
    [true, '--inspect-extensions=9229'],
    [{ break: true }, '--inspect-brk-extensions=9229'],
    [{ port: 9230, break: true }, '--inspect-brk-extensions=9230']
  ])('translates debug %j to %s', (debug, expected) => {
    expect(createLaunchArgs({ debug: debug as boolean | { port?: number; break?: boolean } })).toContain(expected);
  });

  it('prefers profilePath over cachePath', () => {
    const args = createLaunchArgs({ cachePath: 'shared/cache', profilePath: 'cache/profile-xyz' });
    expect(args).toContain('--extensions-dir=cache/profile-xyz/extensions');
    expect(args).toContain('--user-data-dir=cache/profile-xyz/user-data');
    expect(args).not.toContain('shared/cache');
  });

  it('respects explicit profile args in user launchArgs', () => {
    const args = createLaunchArgs({ launchArgs: ['--user-data-dir=/my/data', '--extensions-dir=/my/exts'] });
    expect(args).toContain('--user-data-dir=/my/data');
    expect(args).toContain('--extensions-dir=/my/exts');
    expect(args.filter(arg => arg.startsWith('--user-data-dir'))).toHaveLength(1);
    expect(args.filter(arg => arg.startsWith('--extensions-dir'))).toHaveLength(1);
  });
});
