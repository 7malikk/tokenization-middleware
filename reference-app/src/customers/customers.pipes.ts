import { BadRequestException, Injectable, NotFoundException, PipeTransform } from '@nestjs/common';

// Error messages are fixed strings. They never echo a submitted value.

export interface CreateCustomerBody {
  fullName: string;
  bvn: string;
}

const BVN_FORMAT = /^[0-9]{11}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME_LENGTH = 200;

@Injectable()
export class CreateCustomerPipe implements PipeTransform<unknown, CreateCustomerBody> {
  transform(body: unknown): CreateCustomerBody {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new BadRequestException('request body must be a JSON object');
    }
    const record = body as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== 'fullName' && key !== 'bvn')) {
      throw new BadRequestException('request body may only contain: fullName, bvn');
    }
    const { fullName, bvn } = record;
    if (typeof fullName !== 'string' || fullName.trim().length === 0 || fullName.length > MAX_NAME_LENGTH) {
      throw new BadRequestException(`fullName must be 1 to ${MAX_NAME_LENGTH} characters`);
    }
    if (typeof bvn !== 'string' || !BVN_FORMAT.test(bvn)) {
      throw new BadRequestException('bvn must be exactly 11 digits');
    }
    return { fullName: fullName.trim(), bvn };
  }
}

/** Customer ids are uuids. Anything else cannot exist, so it is a 404. */
@Injectable()
export class CustomerIdPipe implements PipeTransform<string, string> {
  transform(id: string): string {
    if (!UUID.test(id)) {
      throw new NotFoundException('customer not found');
    }
    return id.toLowerCase();
  }
}
