import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { OperatorRole } from './operator.entity.js';

export const IS_PUBLIC = 'auth:public';
export const REQUIRED_ROLES = 'auth:roles';

/** Authenticated operator attached to the request by the auth guard. */
export interface CurrentOperator {
  id: string;
  username: string;
  roles: OperatorRole[];
}

/** Marks a route as reachable without a token. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Requires the operator to hold at least one of `roles`. */
export const Roles = (...roles: OperatorRole[]) => SetMetadata(REQUIRED_ROLES, roles);

/** Injects the authenticated operator. */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): CurrentOperator => {
  return context.switchToHttp().getRequest<{ operator: CurrentOperator }>().operator;
});
