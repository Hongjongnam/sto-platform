import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { type CurrentOperator, CurrentUser, Public } from './auth.decorators.js';
import { AuthService } from './auth.service.js';

const loginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
});
type LoginDto = z.infer<typeof loginSchema>;

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  // Slows down password guessing.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Exchange a username and password for an access token' })
  login(@Body({ schema: loginSchema }) body: LoginDto) {
    return this.auth.login(body.username, body.password);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The authenticated operator' })
  me(@CurrentUser() operator: CurrentOperator) {
    return this.auth.findById(operator.id);
  }
}
