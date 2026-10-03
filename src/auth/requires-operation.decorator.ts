import { SetMetadata } from '@nestjs/common';
import { Operation } from '@prisma/client';

export const REQUIRED_OPERATION = 'requiredOperation';

/** The operation a route performs. The caller's credential must have this scope. */
export const RequiresOperation = (operation: Operation) => SetMetadata(REQUIRED_OPERATION, operation);
