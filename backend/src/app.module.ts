import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module.js';
import { ChainModule } from './chain/chain.module.js';
import { type Env, validateEnv } from './config/env.js';
import { dataSourceOptions } from './database/data-source.options.js';
import { IdentityModule } from './identity/identity.module.js';
import { HealthController } from './health/health.controller.js';
import { LedgerModule } from './ledger/ledger.module.js';
import { OperationsModule } from './operations/operations.module.js';
import { OutboxModule } from './outbox/outbox.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        ...dataSourceOptions(config.get('DATABASE_URL', { infer: true })),
        autoLoadEntities: true,
        migrationsRun: true,
      }),
    }),
    // General request limit per client; individual routes can tighten it.
    ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 300 }] }),
    AuthModule,
    ChainModule,
    OutboxModule,
    IdentityModule,
    OperationsModule,
    LedgerModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
  controllers: [HealthController],
})
export class AppModule {}
