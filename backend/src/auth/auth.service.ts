import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Operator, type OperatorRole } from './operator.entity.js';
import { hashPassword, verifyPassword } from './password.js';

// Verified against when the username is unknown, so both paths take the same time.
const DUMMY_HASH = await hashPassword('unused-password-for-timing');

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(Operator) private readonly operators: Repository<Operator>,
    private readonly jwt: JwtService,
  ) {}

  /** Returns an access token, or rejects with the same error for an unknown user and a wrong password. */
  async login(username: string, password: string): Promise<{ accessToken: string; operator: OperatorView }> {
    const operator = await this.operators.findOneBy({ username });
    const valid = await verifyPassword(password, operator?.passwordHash ?? DUMMY_HASH);
    if (!operator || !valid || !operator.active) throw new UnauthorizedException('Invalid username or password');
    return { accessToken: await this.jwt.signAsync({ sub: operator.id }), operator: toView(operator) };
  }

  /** Creates an operator, or updates the roles and password of an existing one. */
  async upsertOperator(input: { username: string; displayName: string; password: string; roles: OperatorRole[] }): Promise<Operator> {
    const existing = await this.operators.findOneBy({ username: input.username });
    const operator = existing ?? this.operators.create({ username: input.username });
    operator.displayName = input.displayName;
    operator.passwordHash = await hashPassword(input.password);
    operator.roles = input.roles;
    operator.active = true;
    return this.operators.save(operator);
  }

  async findById(id: string): Promise<OperatorView | null> {
    const operator = await this.operators.findOneBy({ id });
    return operator ? toView(operator) : null;
  }
}

export interface OperatorView {
  id: string;
  username: string;
  displayName: string;
  roles: OperatorRole[];
}

function toView(operator: Operator): OperatorView {
  return { id: operator.id, username: operator.username, displayName: operator.displayName, roles: operator.roles };
}
