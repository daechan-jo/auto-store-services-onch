import { Entity, Column, PrimaryGeneratedColumn, ManyToOne, CreateDateColumn } from 'typeorm';

import { OnchProduct } from './onchProduct.entity';

@Entity({ name: 'onch_item' })
export class OnchItem {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'item_name', type: 'varchar', length: 255, nullable: false })
  itemName: string;

  @Column({ name: 'consumer_price', type: 'int', nullable: true })
  consumerPrice: number;

  @Column({ name: 'seller_price', type: 'int', nullable: true })
  sellerPrice: number;

  @ManyToOne(() => OnchProduct, (onchProduct) => onchProduct.onchItems, {
    onDelete: 'CASCADE',
  })
  onchProduct: OnchProduct;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
