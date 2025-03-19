import { CoupangOrderInfo, OnchSoldout, CronType, OnchProduct } from '@daechanjo/models';
import { PlaywrightService } from '@daechanjo/playwright';
import { Injectable } from '@nestjs/common';
import { Page } from 'playwright';

import { AutomaticOrderingProvider } from './provider/automaticOrdering.provider';
import { CrawlingOnchSoldoutProductsProvider } from './provider/crawlingOnchSoldoutProducts.provider';
import { CrawlOnchDetailProductsProvider } from './provider/crawlOnchDetailProducts.provider';
import { CrawlOnchRegisteredProductsProvider } from './provider/crawlOnchRegisteredProducts.provider';
import { DeleteProductsProvider } from './provider/deleteProducts.provider';
import { WaybillExtractionProvider } from './provider/waybillExtraction.provider';
import { OnchRepository } from '../../infrastructure/repository/onch.repository';

@Injectable()
export class OnchCrawlerService {
  constructor(
    private readonly onchRepository: OnchRepository,
    private readonly playwrightService: PlaywrightService,
    private readonly deleteProductsProvider: DeleteProductsProvider,
    private readonly crawlingOnchSoldoutProductsProvider: CrawlingOnchSoldoutProductsProvider,
    private readonly crawlOnchRegisteredProductsProvider: CrawlOnchRegisteredProductsProvider,
    private readonly crawlOnchDetailProductsProvider: CrawlOnchDetailProductsProvider,
    private readonly automaticOrderingProvider: AutomaticOrderingProvider,
    private readonly waybillExtractionProvider: WaybillExtractionProvider,
  ) {}

  /**
   * 쿠팡과 네이버 플랫폼에서 품절된 상품을 온채널에서 삭제합니다.
   *
   * @param cronId - 현재 실행 중인 크론 작업의 고유 식별자
   * @param store - 삭제 작업을 수행할 스토어 이름
   * @param type - 로그 메시지에 포함될 작업 유형 식별자
   * @param matchedCoupangProducts - 쿠팡에서 품절된 상품 목록 배열
   * @param matchedNaverProducts - 네이버에서 품절된 상품 목록 배열 (선택적)
   *
   * @returns {Promise<void>} - 삭제 작업 완료 시 해결되는 Promise
   *
   * @description
   * 이 메서드는 다음 단계로 진행됩니다:
   * 1. 쿠팡과 네이버의 품절 상품에서 온채널 상품 코드 추출
   * 2. 배치 단위로 상품 삭제 작업을 수행하여 성능 최적화
   * 3. 진행 상황 및 결과를 로깅
   */
  async deleteProducts(
    cronId: string,
    store: string,
    type: string,
    matchedCoupangProducts: any[],
    matchedNaverProducts?: any[],
  ): Promise<void> {
    console.log(`${type}${cronId}: 온채널 품절상품 삭제`);
    const contextId = `context-${store}-${cronId}`;

    // 상품 코드 추출
    const productCodesArray = this.deleteProductsProvider.extractProductCodes(
      matchedCoupangProducts,
      matchedNaverProducts,
    );
    const totalProducts = productCodesArray.length;

    if (totalProducts === 0) {
      console.log(`${type}${cronId}: 삭제할 상품이 없습니다.`);
      return;
    }

    console.log(`${type}${cronId}: 총 ${totalProducts}개 상품 삭제 예정`);

    try {
      // 삭제 작업 수행
      const result = await this.deleteProductsProvider.performBatchDeletion(
        contextId,
        cronId,
        store,
        type,
        productCodesArray,
      );

      // 최종 결과 로깅
      console.log(
        `${type}${cronId}: 상품 삭제 작업 완료. 성공: ${result.successCount}, 실패: ${result.failedCount}`,
      );
    } finally {
      // 컨텍스트 리소스 해제
      await this.playwrightService.releaseContext(contextId);
    }
  }

  /**
   * 온채널에서 마지막 크론 작업 이후 품절된 상품들을 크롤링하는 메서드
   *
   * @param lastCronTime - 마지막 크론 작업 실행 시간 (ISO 문자열 형식)
   * @param store - 크롤링 대상 스토어 이름
   * @param cronId - 현재 실행 중인 크론 작업의 고유 식별자
   * @param type - 로그 메시지에 포함될 작업 유형 식별자
   *
   * @returns {Promise<{stockProductCodes: string[], productDates: string[]}>} -
   *          품절된 상품 코드 배열과 해당 상품들의 등록/수정 날짜 배열을 포함하는 Promise
   *
   * @throws {Error} - Playwright 작업 중 발생하는 모든 오류
   *
   * @description
   * 이 메서드는 다음 단계로 진행됩니다:
   * 1. 온채널 관리자 사이트에 로그인 (playwrightService 사용)
   * 2. 상품 목록 페이지로 이동하여 데이터 크롤링
   * 3. 마지막 크론 실행 시간 이후에 추가/수정된 품절 상품만 필터링
   * 4. 상품 코드와 등록/수정 날짜 정보 추출
   * 5. 크롤링 완료 후 Playwright 컨텍스트 리소스 해제
   *
   * 크롤링 과정에서 오류가 발생하면 에러 로그를 남기고 예외를 다시 던집니다.
   * finally 블록에서 컨텍스트 리소스를 확실히 해제하여 메모리 누수를 방지합니다.
   */
  async crawlingOnchSoldoutProducts(
    lastCronTime: string,
    store: string,
    cronId: string,
    type: string,
  ): Promise<{ stockProductCodes: string[]; productDates: string[] }> {
    const pageId = `page-${store}-${cronId}`;
    const contextId = `context-${store}-${cronId}`;

    const parsedLastCronTime = new Date(lastCronTime);

    try {
      // 1. 온채널 관리자 로그인 및 페이지 이동
      const onchPage = await this.playwrightService.loginToOnchSite(store, contextId, pageId);

      // 2. 품절 상품 정보 추출
      const result = await this.crawlingOnchSoldoutProductsProvider.extractSoldOutProducts(
        onchPage,
        parsedLastCronTime,
      );

      await this.playwrightService.releaseContext(contextId);

      console.log(
        `${type}${cronId}: 온채널 품절상품 크롤링 완료. 총 ${result.stockProductCodes.length}개 상품`,
      );

      return result;
    } catch (error: any) {
      console.error(
        `${CronType.ERROR}${type}${cronId}: 온채널 품절상품 크롤링 오류\n`,
        error.message || error,
      );
      throw error;
    } finally {
      await this.playwrightService.releaseContext(contextId);
    }
  }

  /**
   * 온채널에 등록된 모든 판매 상품을 페이지네이션하며 크롤링하는 메서드
   *
   * @param cronId - 현재 실행 중인 크론 작업의 고유 식별자
   * @param store - 크롤링 대상 스토어 이름
   * @param type - 로그 메시지에 포함될 작업 유형 식별자
   *
   * @returns {Promise<void>} - 크롤링 작업 완료 시 해결되는 Promise
   *
   * @throws {Error} - Playwright 작업 중 발생하는 모든 오류
   *
   * @description
   * 이 메서드는 다음 단계로 진행됩니다:
   * 1. 온채널 관리자 사이트에 로그인 (playwrightService 사용)
   * 2. 페이지네이션을 통해 모든 상품 페이지를 순회하며 상품 ID 추출
   * 3. 각 페이지에서 상품 고유번호(num 파라미터)를 수집
   * 4. 빈 페이지가 나올 때까지 크롤링 계속 진행
   * 5. 수집된 모든 상품 ID를 crawlOnchDetailProducts 메서드로 전달하여 상세 정보 크롤링
   *
   * 10페이지마다 진행 상황을 로깅하여 크롤링 진행 상태를 모니터링할 수 있습니다.
   * 모든 상품 ID 수집 후 Playwright 컨텍스트를 해제하여 리소스 누수를 방지합니다.
   */
  async crawlOnchRegisteredProducts(cronId: string, store: string, type: string): Promise<void> {
    const pageId = `page-${store}-${cronId}`;
    const contextId = `context-${store}-${cronId}`;

    const onchPage = await this.playwrightService.loginToOnchSite(store, contextId, pageId);

    console.log(`${type}${cronId}: 온채널 판매상품 리스트업 시작...`);
    const allProductIds = await this.crawlOnchRegisteredProductsProvider.crawlProductList(
      onchPage,
      cronId,
      type,
    );

    await this.crawlOnchDetailProducts(store, cronId, onchPage, contextId, allProductIds);
  }

  /**
   * 온채널 상품의 상세 정보 크롤링 메서드 (병렬옵션)
   *
   * @Param store - 크롤링 대상 스토어 이름
   * @param cronId - 현재 실행 중인 크론 작업의 고유 식별자
   * @param onchPage - 온채널 관리자 페이지 객체
   * @Param contextId - 현재 실행 중인 컨텍스트의 고유 식별자
   * @param allProductIds - 크롤링할 모든 상품 ID 배열
   *
   * @returns {Promise<void>} - 크롤링 작업 완료 시 해결되는 Promise
   *
   * @throws {Error} - Playwright 작업 중 발생하는 모든 오류
   *
   * @description
   * 이 메서드는 다음 단계로 진행됩니다:
   * 1. 상품 ID 목록을 청크로 분할하여 병렬 처리 준비
   * 2. 각 청크마다 별도의 브라우저 컨텍스트와 페이지를 생성하여 병렬 크롤링 수행
   * 3. 각 상품 페이지에서 소비자가, 판매가, 배송비, 옵션 정보 등을 추출
   * 4. 배치 단위로 데이터베이스에 상세 정보 저장
   * 5. 진행률을 10% 단위로 로깅하여 작업 상태 모니터링
   * 6. 모든 작업 완료 후 사용된 브라우저 컨텍스트 리소스 해제
   *
   * Promise.all을 사용하여 여러 상품을 동시에 처리함으로써 크롤링 속도를 크게 향상시킵니다.
   * 각 워커는 최대 50개 상품을 처리한 후 데이터베이스에 저장하여 메모리 사용을 최적화합니다.
   */
  async crawlOnchDetailProducts(
    store: string,
    cronId: string,
    onchPage: Page,
    contextId: string,
    allProductIds: string[],
  ): Promise<void> {
    console.log(`${CronType.PRICE}${cronId}: 온채널 판매상품 상세정보 크롤링 시작...`);
    // 병렬 처리 설정
    const CONCURRENT_PAGES = 2; // 동시에 사용할 페이지 수
    const BATCH_SIZE = 50; // 데이터베이스 저장 배치 크기

    try {
      // 1. 병렬 처리를 위한 페이지 생성
      const pages = await this.playwrightService.createParallelPages(
        store,
        cronId,
        CONCURRENT_PAGES,
      );

      console.log(`${CronType.PRICE}${cronId}: 총 ${pages.length}개 페이지로 병렬 처리 시작`);

      // 2. 상품 정보 병렬 추출 및 처리
      const result = await this.playwrightService.processItemsInParallel<string, OnchProduct>(
        pages,
        allProductIds,
        async (page, productId) => {
          return this.crawlOnchDetailProductsProvider.extractProductDetails(page, productId);
        },
        BATCH_SIZE,
        async (batch) => {
          await this.onchRepository.saveOnchProductDetails(batch);
        },
        (completed, total) => {
          if (completed % Math.ceil(total / 10) === 0 || completed === total) {
            console.log(
              `${CronType.PRICE}${cronId}: 진행률 ${completed}/${total} (${Math.round((completed / total) * 100)}%)`,
            );
          }
        },
      );

      console.log(
        `${CronType.PRICE}${cronId}: 온채널 판매상품 상세정보 크롤링 완료. 성공: ${result.successCount}, 실패: ${result.failCount}`,
      );
    } catch (error) {
      console.error(`${CronType.ERROR}${cronId}: 병렬 크롤링 중 심각한 오류 발생`, error);
      throw error;
    } finally {
      await this.playwrightService.releaseContext(contextId);
    }
  }

  /**
   * 쿠팡 주문 정보를 바탕으로 온채널에서 자동 발주를 수행
   *
   * @param cronId - 현재 실행 중인 크론 작업의 고유 식별자
   * @param store - 발주를 수행할 스토어 이름
   * @param newOrderProducts - 발주할 쿠팡 주문 정보 배열
   * @param type - 로그 메시지에 포함될 작업 유형 식별자
   *
   * @returns {Promise<Array>} - 각 주문 항목별 발주 결과 객체를 포함하는 배열을 반환하는 Promise
   *                            성공 시: {status: 'success', orderId, ordererName, receiverName, sellerProductName, sellerProductItemName, shippingCount}
   *                            실패 시: {status: 'failed', orderId, ordererName, receiverName, productCode, sellerProductName,
   *                                    sellerProductItemName, shippingCount, safeNumber, fullAddress, error}
   *
   * @throws {Error} - Playwright 작업 중 발생하는 모든 오류는 개별 주문 항목 처리에서 캐치되어 결과 배열에 포함됨
   *
   * @description
   * 이 메서드는 다음 단계로 진행됩니다:
   * 1. 온채널 관리자 사이트에 로그인 (playwrightService 사용)
   * 2. 각 쿠팡 주문 및 하위 주문 항목에 대해 다음 작업 수행:
   *    a. 상품 정보 검증 (쿠팡에서 받은 상품명과 온채널 상품명 일치 여부 확인)
   *    b. 상품코드로 온채널에서 상품 검색
   *    c. 주문 항목의 옵션 선택
   *    d. 주문 수량 설정
   *    e. 주문자, 수령인 등 주문 상세 정보 입력
   *    f. 주문 완료 버튼 클릭 및 확인 대화상자 자동 수락
   *    g. 주문 결과 기록
   * 3. 모든 주문 처리 완료 후 Playwright 컨텍스트 리소스 해제
   *
   * 주문 정보 검증 과정에서 불일치가 발견되면 로그에 경고 메시지를 출력하지만,
   * 발주 프로세스는 계속 진행됩니다. 각 주문 항목별로 성공/실패 결과를 기록하여 반환합니다.
   */
  async automaticOrdering(
    cronId: string,
    store: string,
    newOrderProducts: CoupangOrderInfo[],
    type: string,
  ): Promise<Array<any>> {
    const contextId = `context-${store}-${cronId}`;
    const pageId = `page-${store}-${cronId}`;
    const onchPage = await this.playwrightService.loginToOnchSite(store, contextId, pageId);
    const results = []; // 발주 결과 저장 배열

    try {
      for (const order of newOrderProducts) {
        for (const item of order.orderItems) {
          const sellerProductName = item.sellerProductName;
          const sellerProductItemName = item.sellerProductItemName; // 옵션명
          const productCode = item.externalVendorSkuCode;
          const vendorItemName = item.vendorItemName; // 상품 + 옵션 쏘 지저분
          const exposedProductName = `${item.sellerProductName}, ${item.sellerProductItemName}`;

          const productNameWithoutCode = sellerProductName.replace(/^\S+\s+/, '');
          const combinedName = productNameWithoutCode + ', ' + sellerProductItemName;

          console.log(`${type}${cronId}: ${vendorItemName}`);
          console.log(`${type}${cronId}: ${exposedProductName} + ${item.shippingCount}`);
          const isValid = vendorItemName.includes(combinedName);

          if (!isValid)
            console.log(`❗️${type}${cronId}: 발주 확인 필요 ${vendorItemName} = ${combinedName}`);

          try {
            // 상품검색
            await this.automaticOrderingProvider.searchProduct(onchPage, productCode, cronId, type);

            // 옵션설정
            await this.automaticOrderingProvider.selectProductOption(
              onchPage,
              sellerProductItemName,
              cronId,
              type,
            );

            // 수량설정
            await this.automaticOrderingProvider.setProductQuantity(
              onchPage,
              item.shippingCount,
              cronId,
              type,
            );

            // 주문 정보 입력
            await this.automaticOrderingProvider.fillOrderDetails(onchPage, order, cronId, type);

            // 주문 처리
            const completeButtonSelector = '.btnOrderComplete';
            onchPage.once('dialog', async (dialog) => {
              await dialog.accept();
            });

            await onchPage.click(completeButtonSelector);
            await onchPage.waitForLoadState('networkidle');

            await onchPage.goto('https://www.onch3.co.kr/index.php');

            results.push({
              status: 'success',
              orderId: order.orderId,
              ordererName: order.orderer.name,
              receiverName: order.receiver.name,
              sellerProductName: item.sellerProductName,
              sellerProductItemName: item.sellerProductItemName,
              shippingCount: item.shippingCount,
            });
          } catch (error: any) {
            results.push({
              status: 'failed',
              orderId: order.orderId,
              ordererName: order.orderer.name,
              receiverName: order.receiver.name,
              productCode: productCode,
              sellerProductName: item.sellerProductName,
              sellerProductItemName: item.sellerProductItemName,
              shippingCount: item.shippingCount,
              safeNumber: order.receiver.safeNumber,
              fullAddress: order.receiver.addr1 + order.receiver.addr2,
              error: error.message,
            });
          }
        }
      }
      await this.playwrightService.releaseContext(contextId);

      return results;
    } catch (error: any) {
      console.error(`${CronType.ERROR}${type}${cronId}: 발주 중 오류 발생`, error);
    } finally {
      await this.playwrightService.releaseContext(contextId);
    }
  }

  /**
   * 온채널에서 운송장 정보를 추출하는 메서드
   *
   * @param cronId - 현재 실행 중인 크론 작업의 고유 식별자
   * @param store - 스토어 식별자 (온채널 계정 구분용)
   * @param lastCronTime - 마지막으로 크론이 실행된 시간 (이 시간 이후의 주문만 처리)
   * @param type - 로그 메시지에 포함될 작업 유형 식별자
   *
   * @returns {Promise<OnchSoldout[]>} - 추출된 운송장 정보 배열을 반환하는 Promise
   *
   * @description
   * 이 메서드는 온채널 사이트에서 다음 작업을 수행합니다:
   * 1. 온채널 사이트에 로그인하고 관리자 페이지로 이동
   * 2. 판매 완료된 주문 목록에서 마지막 크론 실행 시간 이후의 데이터만 추출
   * 3. 고객 정보, 배송 상태, 결제 방법, 택배사, 송장번호 등의 정보 수집
   * 4. 페이지네이션을 통해 모든 페이지의 데이터를 스크래핑
   * 5. 작업 완료 후 Playwright 컨텍스트 해제
   */
  async waybillExtraction(
    cronId: string,
    store: string,
    lastCronTime: Date,
    type: string,
  ): Promise<OnchSoldout[]> {
    // 브라우저 컨텍스트와 페이지를 구분하기 위한 고유 ID 생성
    const contextId = `context-${store}-${cronId}`;
    const pageId = `page-${store}-${cronId}`;

    // 온채널 사이트에 로그인하고 페이지 객체 획득
    const onchPage = await this.playwrightService.loginToOnchSite(store, contextId, pageId);

    try {
      // 관리자 제품 페이지로 이동 (타임아웃 무제한 설정)
      await onchPage.goto('https://www.onch3.co.kr/admin_mem_prd.html', {
        timeout: 0,
      });

      console.log(`${type}${cronId}: 운송장 추출 시작`);

      // 운송장 데이터 추출
      return await this.waybillExtractionProvider.extractWaybillData(
        onchPage,
        lastCronTime,
        type,
        cronId,
      );
    } catch (error: any) {
      // 전체 프로세스 오류 처리
      console.error(
        `${CronType.ERROR}${type}${cronId}: 운송장 추출 중 오류 발생: ${error.message}`,
      );
      return [];
    } finally {
      // 작업 완료 후 브라우저 컨텍스트 해제 (리소스 정리)
      await this.playwrightService.releaseContext(contextId);
    }
  }
}
