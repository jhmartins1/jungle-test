
import { Module } from '@nestjs/common';

import { WagerTransactionController } from './presentation/controllers/wager-transaction.controller.js';

import { ProcessWagerTransactionUseCase } from './application/use-cases/process-wager-transaction.use-case.js';

import { PendingReferenceProcessorService } from './application/pending-reference-processor.service.js';

import { PendingReferenceWorkerService } from './application/pending-reference-worker.service.js';

@Module({
    controllers: [
        WagerTransactionController,
    ],
    providers: [
        ProcessWagerTransactionUseCase,
        PendingReferenceProcessorService,
        PendingReferenceWorkerService,
    ],
    exports: [
        PendingReferenceProcessorService,
    ],
})
export class WageringModule { }
