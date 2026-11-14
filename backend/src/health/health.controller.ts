import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly dataSource: DataSource) {}

  @Get()
  @ApiOperation({ summary: 'Liveness and database connectivity' })
  async check(): Promise<{ status: 'ok'; database: 'up' }> {
    await this.dataSource.query('SELECT 1');
    return { status: 'ok', database: 'up' };
  }
}
