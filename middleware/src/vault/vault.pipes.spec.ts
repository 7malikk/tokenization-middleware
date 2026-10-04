import { BadRequestException } from '@nestjs/common';
import { syntheticBvn } from '../../test/helpers/synthetic-bvn';
import { allowedDataTypes, TokenBodyPipe, TokenizeBodyPipe } from './vault.pipes';

// Each rejection is checked for the exception type and that its message does
// not contain the submitted value.
function rejectionMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return JSON.stringify((err as BadRequestException).getResponse());
  }
  throw new Error('expected a BadRequestException');
}

describe('TokenizeBodyPipe', () => {
  const pipe = new TokenizeBodyPipe({});

  it('accepts a BVN of exactly 11 digits', () => {
    const value = syntheticBvn();
    const out = pipe.transform({ dataType: 'BVN', value });
    expect(out.dataType).toBe('BVN');
    expect(out.value === value).toBe(true);
  });

  it.each([
    ['10 digits', () => syntheticBvn().slice(0, 10)],
    ['12 digits', () => syntheticBvn() + '0'],
    ['a non-digit', () => syntheticBvn().slice(0, 10) + 'x'],
    ['surrounding spaces', () => ` ${syntheticBvn()}`],
    ['non-ASCII digits', () => '١'.repeat(11)],
  ])('rejects a BVN with %s without echoing it', (_label, make) => {
    const value = make();
    expect(rejectionMessage(() => pipe.transform({ dataType: 'BVN', value })).includes(value)).toBe(false);
  });

  it('rejects a numeric (non-string) value', () => {
    rejectionMessage(() => pipe.transform({ dataType: 'BVN', value: Number(syntheticBvn()) }));
  });

  it('rejects an unknown dataType without echoing it', () => {
    expect(rejectionMessage(() => pipe.transform({ dataType: 'NIN_X', value: syntheticBvn() }))).not.toContain(
      'NIN_X',
    );
  });

  it('rejects non-objects and unexpected fields', () => {
    rejectionMessage(() => pipe.transform(null));
    rejectionMessage(() => pipe.transform([syntheticBvn()]));
    rejectionMessage(() => pipe.transform({ dataType: 'BVN', value: syntheticBvn(), extra: 1 }));
    rejectionMessage(() => pipe.transform(JSON.parse('{"dataType":"BVN","value":"1","__proto__":{}}')));
  });
});

describe('TokenBodyPipe', () => {
  const pipe = new TokenBodyPipe();

  it('accepts 32 lowercase hex chars', () => {
    expect(pipe.transform({ token: 'a'.repeat(32) })).toEqual({ token: 'a'.repeat(32) });
  });

  it.each(['A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), 'g'.repeat(32), syntheticBvn()])(
    'rejects %s without echoing it',
    (token) => {
      expect(rejectionMessage(() => pipe.transform({ token })).includes(token)).toBe(false);
    },
  );
});

describe('allowedDataTypes', () => {
  it('defaults to BVN', () => {
    expect([...allowedDataTypes({})]).toEqual(['BVN']);
  });

  it('refuses a data type with no known format', () => {
    expect(() => allowedDataTypes({ ALLOWED_DATA_TYPES: 'BVN,PASSPORT' })).toThrow('no known format');
  });
});
