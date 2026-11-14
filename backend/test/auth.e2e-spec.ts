import { Controller, Get, type INestApplication, Module, StandardSchemaValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import type { Repository } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { Roles } from '../src/auth/auth.decorators.js';
import { AuthService } from '../src/auth/auth.service.js';
import { Operator, OperatorRole } from '../src/auth/operator.entity.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';

@Controller('probe')
class ProbeController {
  @Get('any')
  any() {
    return { ok: true };
  }

  @Get('approver')
  @Roles(OperatorRole.Approver)
  approver() {
    return { ok: true };
  }
}

@Module({ imports: [AppModule], controllers: [ProbeController] })
class ProbeModule {}

describe('auth', () => {
  let app: INestApplication;
  let auth: AuthService;
  let operators: Repository<Operator>;
  const PASSWORD = 'correct horse battery staple';

  const login = (username: string, password: string) =>
    request(app.getHttpServer()).post('/auth/login').send({ username, password });
  const tokenFor = async (username: string) => (await login(username, PASSWORD)).body.accessToken as string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new StandardSchemaValidationPipe());
    await app.init();
    auth = app.get(AuthService);
    operators = app.get(getRepositoryToken(Operator));
    await auth.upsertOperator({ username: 'maker', displayName: 'Maker', password: PASSWORD, roles: [OperatorRole.Requester] });
    await auth.upsertOperator({ username: 'checker', displayName: 'Checker', password: PASSWORD, roles: [OperatorRole.Approver] });
  });

  afterAll(async () => {
    await app.close();
  });

  it('hashes passwords with a random salt and verifies them', async () => {
    const first = await hashPassword(PASSWORD);
    const second = await hashPassword(PASSWORD);
    expect(first).not.toBe(second);
    expect(first.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword(PASSWORD, first)).toBe(true);
    expect(await verifyPassword('wrong', first)).toBe(false);
    expect(await verifyPassword(PASSWORD, 'not-a-hash')).toBe(false);
  });

  it('issues a token for valid credentials and never returns the password hash', async () => {
    const response = await login('maker', PASSWORD);
    expect(response.status).toBe(200);
    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(response.body.operator).toMatchObject({ username: 'maker', roles: [OperatorRole.Requester] });
    expect(JSON.stringify(response.body)).not.toContain('scrypt');
  });

  it('rejects a wrong password and an unknown user with the same response', async () => {
    const wrong = await login('maker', 'wrong');
    const unknown = await login('nobody', PASSWORD);
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.message).toBe(unknown.body.message);
  });

  it('validates the login body', async () => {
    const response = await request(app.getHttpServer()).post('/auth/login').send({ username: 'maker' });
    expect(response.status).toBe(400);
  });

  it('requires a token on protected routes and leaves public routes open', async () => {
    expect((await request(app.getHttpServer()).get('/probe/any')).status).toBe(401);
    expect((await request(app.getHttpServer()).get('/probe/any').set('Authorization', 'Bearer garbage')).status).toBe(401);
    expect((await request(app.getHttpServer()).get('/health')).status).toBe(200);

    const token = await tokenFor('maker');
    const response = await request(app.getHttpServer()).get('/probe/any').set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    const me = await request(app.getHttpServer()).get('/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.body).toMatchObject({ username: 'maker', displayName: 'Maker' });
  });

  it('enforces roles', async () => {
    const maker = await tokenFor('maker');
    const checker = await tokenFor('checker');
    expect((await request(app.getHttpServer()).get('/probe/approver').set('Authorization', `Bearer ${maker}`)).status).toBe(403);
    expect((await request(app.getHttpServer()).get('/probe/approver').set('Authorization', `Bearer ${checker}`)).status).toBe(200);
  });

  it('rejects a token signed with another key and an expired token', async () => {
    const operator = await operators.findOneByOrFail({ username: 'maker' });
    const forged = await new JwtService({ secret: 'another-secret-another-secret-another-secret' }).signAsync({ sub: operator.id });
    expect((await request(app.getHttpServer()).get('/probe/any').set('Authorization', `Bearer ${forged}`)).status).toBe(401);

    const expired = await app.get(JwtService).signAsync({ sub: operator.id }, { expiresIn: '-1s' });
    expect((await request(app.getHttpServer()).get('/probe/any').set('Authorization', `Bearer ${expired}`)).status).toBe(401);
  });

  it('cuts off a deactivated operator immediately, even with a valid token', async () => {
    await auth.upsertOperator({ username: 'leaver', displayName: 'Leaver', password: PASSWORD, roles: [OperatorRole.Viewer] });
    const token = await tokenFor('leaver');
    expect((await request(app.getHttpServer()).get('/probe/any').set('Authorization', `Bearer ${token}`)).status).toBe(200);

    await operators.update({ username: 'leaver' }, { active: false });
    expect((await request(app.getHttpServer()).get('/probe/any').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    expect((await login('leaver', PASSWORD)).status).toBe(401);
  });
});
