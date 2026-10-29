
import { Injectable, Logger } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';

import {
    WagerTransactionEntity,
    WagerTransactionStatus,
} from '../infrastructure/persistence/wager-transaction.entity.js';

import {
    ProcessWagerTransactionUseCase,
} from './use-cases/process-wager-transaction.use-case.js';

import {
    WagerOperation,
} from '../presentation/dto/create-wager-transaction.dto.js';

@Injectable()
export class PendingReferenceProcessorService {
    private readonly logger = new Logger(
        PendingReferenceProcessorService.name,
    );

    private readonly batchSize = 50;
    private readonly maxAttempts = 10;
    private readonly ttlHours = 24;
    private readonly baseDelayMs = 10_000;
    private readonly maxDelayMs = 300_000;

    constructor(
        private readonly orm: MikroORM,
        private readonly processTransaction:
            ProcessWagerTransactionUseCase,
    ) { }

    private getBackoffMs(attempt: number): number {
        return Math.min(
            this.baseDelayMs * 2 ** Math.max(0, attempt - 1),
            this.maxDelayMs,
        );
    }


    private async expirePending(): Promise<void> {
        const connection = this.orm.em.getConnection();

        const expired = await connection.execute<
            Array<{ id: string; failure_code: string }>
        >(
            `
        UPDATE wager_transactions
        SET
            status = 'FAILED',
            failure_code = CASE
                WHEN created_at <= NOW() - INTERVAL '24 hours'
                    THEN 'REFERENCE_TTL_EXPIRED'
                ELSE 'REFERENCE_RETRY_EXHAUSTED'
            END,
            processed_at = NOW(),
            next_retry_at = NULL
        WHERE status = 'PENDING_REFERENCE'
          AND (
              created_at <= NOW() - INTERVAL '24 hours'
              OR (
                  retry_attempts >= ?
                  AND (next_retry_at IS NULL OR next_retry_at <= NOW())
              )
          )
        RETURNING id, failure_code
        `,
            [this.maxAttempts],
        );

        for (const item of expired) {
            this.logger.warn(
                `Pending reference expired: ${item.id} (${item.failure_code})`,
            );
        }
    }


    private async claimPending(): Promise<string[]> {
        const connection = this.orm.em.getConnection();

        const claimed = await connection.execute<
            Array<{ id: string }>
        >(
            `
      WITH candidates AS (
        SELECT id
        FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE'
          AND retry_attempts < ?
          AND created_at > NOW() - INTERVAL '24 hours'
          AND (
            next_retry_at IS NULL
            OR next_retry_at <= NOW()
          )
        ORDER BY created_at ASC
        LIMIT ?
        FOR UPDATE SKIP LOCKED
      )
      UPDATE wager_transactions AS transaction
      SET
        retry_attempts = transaction.retry_attempts + 1,
        last_retry_at = NOW(),
        next_retry_at = NOW() + (
          LEAST(
            ? * POWER(
              2,
              LEAST(transaction.retry_attempts, 20)
            ),
            ?
          ) * INTERVAL '1 millisecond'
        )
      FROM candidates
      WHERE transaction.id = candidates.id
      RETURNING transaction.id
      `,
            [
                this.maxAttempts,
                this.batchSize,
                this.baseDelayMs,
                this.maxDelayMs,
            ],
        );

        return claimed.map((item) => item.id);
    }

    async processPending(): Promise<void> {
        await this.expirePending();

        const claimedIds = await this.claimPending();

        for (const id of claimedIds) {
            try {
                const em = this.orm.em.fork();

                const transaction = await em.findOne(
                    WagerTransactionEntity,
                    {
                        id,
                        status:
                            WagerTransactionStatus.PENDING_REFERENCE,
                    },
                );

                if (!transaction) {
                    continue;
                }

                await this.processTransaction.execute(
                    {
                        providerId: transaction.providerId,
                        externalTransactionId:
                            transaction.externalTransactionId,
                        walletId: transaction.walletId,
                        playerId: transaction.playerId,
                        roundId: transaction.roundId,
                        gameId: transaction.gameId,
                        kind: WagerOperation[
                            transaction.kind as keyof typeof WagerOperation
                        ],
                        amount: transaction.amount,
                        currency: transaction.currency,
                        referenceExternalTransactionId:
                            transaction.referenceExternalTransactionId,
                    },
                    transaction.idempotencyKey,
                );
            } catch (error) {
                this.logger.warn(
                    `Unable to reprocess transaction ${id}: ${error instanceof Error
                        ? error.message
                        : String(error)
                    }`,
                );
            }
        }
    }
}
