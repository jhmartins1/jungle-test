
import { Module } from '@nestjs/common';

import { WalletController } from './presentation/controllers/wallet.controller.js';
import { CreateWalletUseCase } from './application/use-cases/create-wallet.use-case.js';

@Module({
    controllers: [WalletController],
    providers: [CreateWalletUseCase],
})
export class WalletModule { }
