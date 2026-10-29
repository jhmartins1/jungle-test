
import {
    Body,
    Controller,
    Headers,
    Post,
    UnprocessableEntityException,
} from '@nestjs/common';

import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case.js';
import { CreateWagerTransactionDto } from '../dto/create-wager-transaction.dto.js';

@Controller('wagering/transactions')
export class WagerTransactionController {
    constructor(
        private readonly processTransaction:
            ProcessWagerTransactionUseCase,
    ) { }

    @Post()
    async create(
        @Body() dto: CreateWagerTransactionDto,
        @Headers('idempotency-key') idempotencyKey: string,
    ) {
        const result = await this.processTransaction.execute(
            dto,
            idempotencyKey,
        );

        if (result.status === 'REJECTED') {
            throw new UnprocessableEntityException(result);
        }

        return result;
    }
}
