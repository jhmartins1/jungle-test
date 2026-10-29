
import { Decimal } from 'decimal.js';

export class Money {
    private readonly amount: Decimal;

    constructor(value: string | Decimal) {
        const amount = new Decimal(value);

        if (!amount.isFinite()) {
            throw new Error('Invalid monetary amount');
        }

        if (amount.decimalPlaces() > 2) {
            throw new Error('Money cannot have more than 2 decimal places');
        }

        this.amount = amount;
    }

    add(other: Money): Money {
        return new Money(this.amount.plus(other.amount));
    }

    subtract(other: Money): Money {
        return new Money(this.amount.minus(other.amount));
    }

    isNegative(): boolean {
        return this.amount.isNegative();
    }

    isZero(): boolean {
        return this.amount.isZero();
    }

    isGreaterThan(other: Money): boolean {
        return this.amount.greaterThan(other.amount);
    }

    toString(): string {
        return this.amount.toFixed(2);
    }
}
