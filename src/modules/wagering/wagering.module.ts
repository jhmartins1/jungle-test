
import { Module } from '@nestjs/common';

import { WagerTransactionController } from './presentation/controllers/wager-transaction.controller.js';
import { ProcessWagerTransactionUseCase } from './application/use-cases/process-wager-transaction.use-case.js';

@Module({
    controllers: [WagerTransactionController],
    providers: [ProcessWagerTransactionUseCase],
})
export class WageringModule { }
