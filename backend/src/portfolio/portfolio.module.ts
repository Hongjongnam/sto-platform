import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { PortfolioController } from './portfolio.controller.js';

@Module({ imports: [IdentityModule], controllers: [PortfolioController] })
export class PortfolioModule {}
