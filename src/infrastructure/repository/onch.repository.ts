import { OnchProduct } from '@daechanjo/models';
import { InjectRepository } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { DataSource, Repository } from 'typeorm';

import { OnchProductEntity } from '../entities/onchProduct.entity';

export class OnchRepository {
  constructor(
    @InjectRepository(OnchProductEntity)
    private readonly onchRepository: Repository<OnchProductEntity>,
    private readonly dataSource: DataSource,
  ) {}

  async saveOnchProductDetails(details: OnchProduct[]) {
    const entities = plainToInstance(OnchProductEntity, details);
    await this.onchRepository.save(entities);
  }

  async getOnchProducts() {
    return await this.onchRepository.find();
  }

  async clearOnchProducts() {
    // return await this.dataSource.query('TRUNCATE TABLE "onch_product" CASCADE');
    return await this.onchRepository.delete({});
  }
}
