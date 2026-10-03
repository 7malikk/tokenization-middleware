import { BadRequestException, NotFoundException } from '@nestjs/common';
import { syntheticBvn } from '../../test/helpers/synthetic-bvn';
import { CreateCustomerPipe, CustomerIdPipe } from './customers.pipes';

describe('CreateCustomerPipe', () => {
  const pipe = new CreateCustomerPipe();

  it('accepts a name and an 11-digit BVN', () => {
    const bvn = syntheticBvn();
    const out = pipe.transform({ fullName: '  Ada Obi ', bvn });
    expect(out.fullName).toBe('Ada Obi');
    expect(out.bvn === bvn).toBe(true);
  });

  it.each([
    ['a 10-digit BVN', { fullName: 'A', bvn: '1234567890' }],
    ['a non-digit BVN', { fullName: 'A', bvn: '1234567890x' }],
    ['a numeric BVN', { fullName: 'A', bvn: 12345678901 }],
    ['an empty name', { fullName: '  ', bvn: '12345678901' }],
    ['an extra field', { fullName: 'A', bvn: '12345678901', role: 'admin' }],
  ])('rejects %s without echoing it', (_label, body) => {
    let message = '';
    try {
      pipe.transform(body);
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      message = JSON.stringify((err as BadRequestException).getResponse());
    }
    expect(message).not.toBe('');
    expect(message.includes(String((body as { bvn: unknown }).bvn))).toBe(false);
  });
});

describe('CustomerIdPipe', () => {
  it('passes uuids and 404s anything else', () => {
    const pipe = new CustomerIdPipe();
    expect(pipe.transform('6F1C2D3E-0000-4000-8000-000000000000')).toBe('6f1c2d3e-0000-4000-8000-000000000000');
    expect(() => pipe.transform('../etc/passwd')).toThrow(NotFoundException);
  });
});
