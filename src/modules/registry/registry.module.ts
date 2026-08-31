import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RegistryContact } from './entities/registry-contact.entity';
import { RegistryBlocked } from './entities/registry-blocked.entity';
import { Message } from '../message/entities/message.entity';
import { Session } from '../session/entities/session.entity';
import { RegistryService } from './registry.service';
import { RegistryController } from './registry.controller';
import { ContactModule } from '../contact/contact.module';
import { SessionModule } from '../session/session.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([RegistryContact, RegistryBlocked, Message, Session], 'data'),
    ContactModule,
    SessionModule,
  ],
  controllers: [RegistryController],
  providers: [RegistryService],
  exports: [RegistryService],
})
export class RegistryModule {}
