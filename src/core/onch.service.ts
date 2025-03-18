import { Injectable } from '@nestjs/common';

import { OnchRepository } from '../infrastructure/repository/onch.repository';

@Injectable()
export class OnchService {
  constructor(private readonly onchRepository: OnchRepository) {}

  async clearOnchProducts() {
    await this.onchRepository.clearOnchProducts();
  }
}
