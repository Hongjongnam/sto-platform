import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { type CurrentOperator, CurrentUser, Roles } from '../auth/auth.decorators.js';
import { OperatorRole } from '../auth/operator.entity.js';
import { ApprovalStatus, OperationType } from './operation.entity.js';
import { OperationsService } from './operations.service.js';

const uuid = z.uuid();

const createSchema = z.object({
  type: z.enum(Object.values(OperationType) as [OperationType, ...OperationType[]]),
  // Checked against the schema of the chosen type in the service.
  params: z.record(z.string(), z.unknown()).default({}),
  // Recorded on chain as bytes32, so at most 31 ASCII characters.
  reasonCode: z.string().regex(/^[A-Z0-9_]{1,31}$/, 'expected an upper-case code of at most 31 characters'),
  evidenceHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'expected a 32-byte hash')
    .optional(),
});
type CreateDto = z.infer<typeof createSchema>;

const listSchema = z.object({
  status: z.enum(Object.values(ApprovalStatus) as [ApprovalStatus, ...ApprovalStatus[]]).optional(),
});
const approveSchema = z.object({ note: z.string().trim().max(500).optional() });
const rejectSchema = z.object({ note: z.string().trim().min(1).max(500) });

@ApiTags('operations')
@ApiBearerAuth()
@Controller('operations')
export class OperationsController {
  constructor(private readonly operations: OperationsService) {}

  @Get()
  @ApiOperation({ summary: 'List operation requests, newest first' })
  list(@Query({ schema: listSchema }) query: z.infer<typeof listSchema>) {
    return this.operations.list(query.status);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One operation request with its approval trail and execution status' })
  get(@Param('id', { schema: uuid }) id: string) {
    return this.operations.get(id);
  }

  @Post()
  @Roles(OperatorRole.Requester)
  @ApiOperation({ summary: 'File a token operation' })
  create(@CurrentUser() operator: CurrentOperator, @Body({ schema: createSchema }) body: CreateDto) {
    return this.operations.create(operator.id, body);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Roles(OperatorRole.Approver)
  @ApiOperation({ summary: 'Approve a request filed by another operator' })
  approve(
    @CurrentUser() operator: CurrentOperator,
    @Param('id', { schema: uuid }) id: string,
    @Body({ schema: approveSchema }) body: z.infer<typeof approveSchema>,
  ) {
    return this.operations.approve(operator.id, id, body.note);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @Roles(OperatorRole.Approver)
  @ApiOperation({ summary: 'Reject a request filed by another operator' })
  reject(
    @CurrentUser() operator: CurrentOperator,
    @Param('id', { schema: uuid }) id: string,
    @Body({ schema: rejectSchema }) body: z.infer<typeof rejectSchema>,
  ) {
    return this.operations.reject(operator.id, id, body.note);
  }
}
