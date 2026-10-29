
import { Body, Controller, Post } from '@nestjs/common';

import { CreateWalletUseCase } from '../../application/use-cases/create-wallet.use-case.js';
import { CreateWalletDto } from '../dto/create-wallet.dto.js';

@Controller('wallets')
export class WalletController {
    constructor(
        private readonly createWalletUseCase: CreateWalletUseCase,
    ) { }

    @Post()
    async create(@Body() dto: CreateWalletDto) {
        return this.createWalletUseCase.execute(dto);
    }
}
