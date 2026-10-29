
import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import {
    LockMode,
    UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';

import { WalletEntity } from '../../../wallet/infrastructure/persistence/wallet.entity.js';
import {
    LedgerDirection,
    WalletLedgerEntryEntity,
} from '../../../wallet/infrastructure/persistence/wallet-ledger-entry.entity.js';
import {
    WagerTransactionEntity,
    WagerTransactionKind,
    WagerTransactionStatus,
} from '../../infrastructure/persistence/wager-transaction.entity.js';
import {
    CreateWagerTransactionDto,
    WagerOperation,
} from '../../presentation/dto/create-wager-transaction.dto.js';
import { OutboxEventEntity, OutboxEventStatus } from '../../../outbox/infrastructure/persistence/outbox-event.entity.js'

@Injectable()
export class ProcessWagerTransactionUseCase {
    constructor(private readonly orm: MikroORM) { }

    async execute(
        dto: CreateWagerTransactionDto,
        idempotencyKey: string,
    ) {
        if (!idempotencyKey?.trim()) {
            throw new BadRequestException(
                'Idempotency-Key header is required',
            );
        }

        const isCompensation =
            dto.kind === WagerOperation.REFUND ||
            dto.kind === WagerOperation.ROLLBACK;

        if (
            isCompensation &&
            !dto.referenceExternalTransactionId?.trim()
        ) {
            throw new BadRequestException(
                'referenceExternalTransactionId is required',
            );
        }

        if (
            !isCompensation &&
            dto.referenceExternalTransactionId
        ) {
            throw new BadRequestException(
                'Reference is only allowed for compensation',
            );
        }

        const amount = new Decimal(dto.amount);

        if (
            !amount.isFinite() ||
            !amount.isPositive() ||
            amount.decimalPlaces() > 2 ||
            amount.greaterThan('9999999999999999.99')
        ) {
            throw new BadRequestException('Invalid amount');
        }

        const normalizedAmount = amount.toFixed(2);

        const payloadHash = createHash('sha256')
            .update(
                JSON.stringify({
                    providerId: dto.providerId,
                    externalTransactionId:
                        dto.externalTransactionId,
                    walletId: dto.walletId,
                    playerId: dto.playerId,
                    roundId: dto.roundId,
                    gameId: dto.gameId,
                    kind: dto.kind,
                    amount: normalizedAmount,
                    currency: dto.currency,
                    referenceExternalTransactionId:
                        dto.referenceExternalTransactionId ?? null,
                }),
            )
            .digest('hex');

        try {
            return await this.orm.em.transactional(async (em) => {
                const wallet = await em.findOne(
                    WalletEntity,
                    { id: dto.walletId },
                    { lockMode: LockMode.PESSIMISTIC_WRITE },
                );

                if (!wallet) {
                    throw new NotFoundException('Wallet not found');
                }

                if (wallet.playerId !== dto.playerId) {
                    throw new ConflictException('Player mismatch');
                }

                if (wallet.currency !== dto.currency) {
                    throw new ConflictException('Currency mismatch');
                }

                const existingByKey = await em.findOne(
                    WagerTransactionEntity,
                    {
                        providerId: dto.providerId,
                        idempotencyKey,
                    },
                );

                const existingByExternalId = await em.findOne(
                    WagerTransactionEntity,
                    {
                        providerId: dto.providerId,
                        externalTransactionId:
                            dto.externalTransactionId,
                    },
                );

                const existing =
                    existingByKey ?? existingByExternalId;

                if (existing) {
                    if (
                        existing.payloadHash !== payloadHash ||
                        existing.idempotencyKey !== idempotencyKey ||
                        existing.externalTransactionId !==
                        dto.externalTransactionId
                    ) {
                        throw new ConflictException(
                            'Idempotency conflict',
                        );
                    }

                    const existingLedger = await em.findOne(
                        WalletLedgerEntryEntity,
                        { transactionId: existing.id },
                    );

                    if (
                        existing.status ===
                        WagerTransactionStatus.PROCESSED &&
                        !existingLedger
                    ) {
                        throw new Error(
                            'Processed transaction has no ledger entry',
                        );
                    }

                    return {
                        transactionId: existing.id,
                        status: existing.status,
                        failureCode: existing.failureCode,
                        balance:
                            existingLedger?.balanceAfter ??
                            wallet.balance,
                        replayed: true,
                    };
                }

                let reference: WagerTransactionEntity | null = null;

                if (isCompensation) {
                    reference = await em.findOne(
                        WagerTransactionEntity,
                        {
                            providerId: dto.providerId,
                            externalTransactionId:
                                dto.referenceExternalTransactionId!,
                        },
                    );

                    if (!reference) {
                        throw new NotFoundException(
                            'Reference transaction not found',
                        );
                    }

                    if (
                        reference.walletId !== wallet.id ||
                        reference.playerId !== dto.playerId ||
                        reference.currency !== dto.currency ||
                        reference.roundId !== dto.roundId ||
                        reference.gameId !== dto.gameId
                    ) {
                        throw new ConflictException(
                            'Reference transaction mismatch',
                        );
                    }

                    if (
                        reference.status !==
                        WagerTransactionStatus.PROCESSED
                    ) {
                        throw new ConflictException(
                            'Reference transaction is not processed',
                        );
                    }

                    if (
                        new Decimal(reference.amount).toFixed(2) !==
                        normalizedAmount
                    ) {
                        throw new ConflictException(
                            'Compensation amount mismatch',
                        );
                    }

                    if (
                        dto.kind === WagerOperation.REFUND &&
                        reference.kind !== WagerTransactionKind.BET
                    ) {
                        throw new ConflictException(
                            'REFUND requires a BET transaction',
                        );
                    }

                    if (
                        dto.kind === WagerOperation.ROLLBACK &&
                        reference.kind !== WagerTransactionKind.BET &&
                        reference.kind !== WagerTransactionKind.WIN
                    ) {
                        throw new ConflictException(
                            'ROLLBACK requires a BET or WIN transaction',
                        );
                    }

                    const previousCompensation = await em.findOne(
                        WagerTransactionEntity,
                        {
                            referenceTransactionId: reference.id,
                            status: WagerTransactionStatus.PROCESSED,
                        },
                    );

                    if (previousCompensation) {
                        throw new ConflictException(
                            'Transaction already compensated',
                        );
                    }
                }

                const isDebit =
                    dto.kind === WagerOperation.BET ||
                    (
                        dto.kind === WagerOperation.ROLLBACK &&
                        reference?.kind === WagerTransactionKind.WIN
                    );

                const currentBalance = new Decimal(wallet.balance);

                const nextBalance = isDebit
                    ? currentBalance.minus(amount)
                    : currentBalance.plus(amount);

                if (
                    nextBalance.greaterThan('9999999999999999.99')
                ) {
                    throw new BadRequestException(
                        'Balance exceeds supported limit',
                    );
                }

                const insufficientFunds = nextBalance.isNegative();

                const transaction = em.create(
                    WagerTransactionEntity,
                    {
                        providerId: dto.providerId,
                        externalTransactionId:
                            dto.externalTransactionId,
                        idempotencyKey,
                        payloadHash,
                        walletId: wallet.id,
                        playerId: dto.playerId,
                        roundId: dto.roundId,
                        gameId: dto.gameId,
                        kind: WagerTransactionKind[dto.kind],
                        status: insufficientFunds
                            ? WagerTransactionStatus.REJECTED
                            : WagerTransactionStatus.PROCESSED,
                        amount: normalizedAmount,
                        currency: dto.currency,
                        referenceExternalTransactionId:
                            dto.referenceExternalTransactionId,
                        referenceTransactionId:
                            reference?.id,
                        failureCode: insufficientFunds
                            ? 'INSUFFICIENT_FUNDS'
                            : undefined,
                        processedAt: new Date(),
                        createdAt: new Date(),
                    },
                );

                em.persist(transaction);
                await em.flush();

                if (insufficientFunds) {
                    return {
                        transactionId: transaction.id,
                        status: transaction.status,
                        failureCode: 'INSUFFICIENT_FUNDS',
                        balance: wallet.balance,
                        replayed: false,
                    };
                }

                // 5. Atualizar carteira.
                const before = currentBalance.toFixed(2);
                const after = nextBalance.toFixed(2);

                wallet.balance = after;
                wallet.version += 1;

                // 6. Registrar ledger.
                const ledger = em.create(
                    WalletLedgerEntryEntity,
                    {
                        walletId: wallet.id,
                        transactionId: transaction.id,
                        direction: isDebit
                            ? LedgerDirection.DEBIT
                            : LedgerDirection.CREDIT,
                        amount: normalizedAmount,
                        currency: dto.currency,
                        balanceBefore: before,
                        balanceAfter: after,
                        createdAt: new Date(),
                    },
                );

                em.persist(ledger);
                await em.flush();


                const outboxEvent = em.create(OutboxEventEntity, {
                    eventType: 'wager.transaction.processed',
                    aggregateId: transaction.id,
                    payload: {
                        eventId: transaction.id,
                        transactionId: transaction.id,
                        providerId: dto.providerId,
                        externalTransactionId: dto.externalTransactionId,
                        playerId: dto.playerId,
                        walletId: wallet.id,
                        roundId: dto.roundId,
                        gameId: dto.gameId,
                        kind: dto.kind,
                        amount: normalizedAmount,
                        currency: dto.currency,
                        balanceBefore: before,
                        balanceAfter: after,
                        referenceTransactionId: reference?.id ?? null,
                        occurredAt: new Date().toISOString(),
                    },
                    status: OutboxEventStatus.PENDING,
                    attempts: 0,
                    createdAt: new Date(),
                });

                em.persist(outboxEvent);
                await em.flush();


                return {
                    transactionId: transaction.id,
                    status: transaction.status,
                    balance: wallet.balance,
                    version: wallet.version,
                    replayed: false,
                };
            });
        } catch (error) {
            if (
                error instanceof UniqueConstraintViolationException
            ) {
                throw new ConflictException(
                    'Transaction already exists',
                );
            }

            throw error;
        }
    }
}
