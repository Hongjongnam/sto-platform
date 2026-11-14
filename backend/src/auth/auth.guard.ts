import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { type CurrentOperator, IS_PUBLIC, REQUIRED_ROLES } from './auth.decorators.js';
import { Operator, type OperatorRole } from './operator.entity.js';

/**
 * Global guard: every route needs a valid bearer token unless it is marked `@Public()`.
 * The operator is loaded on each request, so deactivating an operator or changing their
 * roles takes effect immediately, not when the token expires.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    @InjectRepository(Operator) private readonly operators: Repository<Operator>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; operator?: CurrentOperator }>();
    const [scheme, token] = (request.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('Missing bearer token');

    let subject: string;
    try {
      subject = (await this.jwt.verifyAsync<{ sub: string }>(token)).sub;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    const operator = await this.operators.findOneBy({ id: subject, active: true });
    if (!operator) throw new UnauthorizedException('Operator is not active');
    request.operator = { id: operator.id, username: operator.username, roles: operator.roles };

    const required = this.reflector.getAllAndOverride<OperatorRole[] | undefined>(REQUIRED_ROLES, targets);
    if (required?.length && !required.some((role) => operator.roles.includes(role))) {
      throw new ForbiddenException(`Requires one of: ${required.join(', ')}`);
    }
    return true;
  }
}
