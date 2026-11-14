import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AuthService } from '../../src/auth/auth.service.js';
import { OperatorRole } from '../../src/auth/operator.entity.js';

const PASSWORD = 'integration-test-password';

/** Creates one operator per role and returns their bearer tokens. */
export async function operatorTokens(app: INestApplication) {
  const auth = app.get(AuthService);
  const login = async (username: string, roles: OperatorRole[]) => {
    await auth.upsertOperator({ username, displayName: username, password: PASSWORD, roles });
    const response = await request(app.getHttpServer()).post('/auth/login').send({ username, password: PASSWORD });
    return response.body.accessToken as string;
  };
  return {
    viewer: await login('test-viewer', [OperatorRole.Viewer]),
    requester: await login('test-requester', [OperatorRole.Requester]),
    approver: await login('test-approver', [OperatorRole.Approver]),
    secondApprover: await login('test-approver-2', [OperatorRole.Approver, OperatorRole.Requester]),
  };
}
