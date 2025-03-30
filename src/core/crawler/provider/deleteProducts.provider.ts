import {
  CoupangComparisonWithOnchData,
  CoupangPagingProduct,
  CronType,
  Dialog,
  OnchWithCoupangProduct,
} from '@daechanjo/models';
import { NaverChannelProduct } from '@daechanjo/models/dist/interfaces/naver/naverChannelProduct.interface';
import { PlaywrightService } from '@daechanjo/playwright';
import { Injectable } from '@nestjs/common';
import { Page } from 'playwright';

@Injectable()
export class DeleteProductsProvider {
  constructor(private readonly playwrightService: PlaywrightService) {}

  /**
   * 여러 플랫폼의 품절 상품 데이터에서 온채널 상품 코드를 추출하고 중복을 제거합니다.
   *
   * @param deleteProducts - 쿠팡 플랫폼에서 품절된 상품 목록
   * @returns 중복이 제거된 온채널 상품 코드 배열
   *
   * @description
   * - 쿠팡 상품에서는 sellerProductName에서 'CH'로 시작하는 7자리 숫자 코드를 추출
   * - 네이버 상품에서는 sellerManagementCode 필드에서 코드를 추출
   * - Set 객체를 사용하여 중복 코드를 자동으로 제거
   */
  extractProductCodes(
    deleteProducts:
      | OnchWithCoupangProduct[]
      | CoupangPagingProduct[]
      | NaverChannelProduct[]
      | CoupangComparisonWithOnchData[],
  ): string[] {
    const productCodesSet = new Set<string>();

    // 쿠팡 상품 코드 추출
    for (const product of deleteProducts) {
      // 방법 1: coupangProductCode 속성 사용
      if ('coupangProductCode' in product && product.coupangProductCode) {
        productCodesSet.add(product.coupangProductCode.trim());
      }
      // 방법 2: sellerProductName에서 정규표현식으로 추출
      else if ('sellerProductName' in product && product.sellerProductName) {
        const extractedCode = product.sellerProductName.match(/CH\d{7}/)?.[0];
        if (extractedCode) {
          productCodesSet.add(extractedCode);
        }
      } else if ('sellerManagementCode' in product && product.sellerManagementCode) {
        productCodesSet.add(product.sellerManagementCode.trim());
      } else if ('externalVendorSkuCode' in product && product.externalVendorSkuCode) {
        productCodesSet.add(product.externalVendorSkuCode);
      }
    }

    // Set을 배열로 변환
    return Array.from(productCodesSet);
  }

  /**
   * 배치 단위로 상품 삭제 작업을 수행합니다.
   *
   * @param contextId - Playwright 컨텍스트 ID
   * @param cronId - 크론 작업 ID
   * @param store - 스토어 이름
   * @param type - 작업 유형
   * @param productCodes - 삭제할 상품 코드 배열
   * @returns 성공 및 실패 카운트를 포함한 객체
   *
   * @description
   * - 동시에 처리할 수 있는 병렬 작업 단위로 상품 코드를 분할
   * - 각 작업자(페이지)가 배치 단위로 상품을 처리
   * - 모든 작업의 성공/실패 카운트 집계
   */
  async performBatchDeletion(
    contextId: string,
    cronId: string,
    store: string,
    type: string,
    productCodes: string[],
  ): Promise<{ successCount: number; failedCount: number }> {
    const PARALLEL_WORKERS = 2; // 동시에 실행할 작업자(페이지) 수
    let successCount = 0;
    let failedCount = 0;
    const totalProducts = productCodes.length;

    // 작업자(페이지)들을 위한 배열
    const pages: Page[] = [];
    const pageIds: string[] = [];

    try {
      // 최초 로그인
      const firstPageId = `page-${store}-${cronId}-0`;
      pageIds.push(firstPageId);
      const firstPage = await this.playwrightService.loginToOnchSite(store, contextId, firstPageId);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      pages.push(firstPage);

      // 추가 작업자(페이지) 생성
      for (let i = 0; i < PARALLEL_WORKERS - 1; i++) {
        const pageId = `page-${store}-${cronId}-${i + 1}`;
        pageIds.push(pageId);
        const page = await this.playwrightService.createPage(contextId, pageId);
        pages.push(page);
      }

      // 각 작업자에게 할당할 상품 코드 배열 분할
      const productsPerWorker = Math.ceil(totalProducts / PARALLEL_WORKERS);
      const workerBatches: string[][] = [];

      for (let i = 0; i < PARALLEL_WORKERS; i++) {
        const startIndex = i * productsPerWorker;
        const endIndex = Math.min(startIndex + productsPerWorker, totalProducts);

        if (startIndex < totalProducts) {
          workerBatches.push(productCodes.slice(startIndex, endIndex));
        }
      }

      // 각 작업자(페이지)에 배치 할당 및 병렬 처리
      const workerPromises = workerBatches.map(async (batch, index) => {
        if (index < pages.length) {
          const result = await this.deleteProductBatch(
            store,
            contextId,
            pageIds[index],
            batch,
            cronId,
            type,
            pages[index],
          );

          successCount += result.successCount;
          failedCount += result.failedCount;

          return result;
        }
      });

      // 모든 작업자의 작업 완료 대기
      await Promise.all(workerPromises);

      console.log(
        `${type}${cronId}: 완료 - 성공: ${successCount}, 실패: ${failedCount}, 총 상품 수: ${totalProducts}`,
      );
    } finally {
      // 모든 작업이 끝난 후 페이지 리소스 해제
      for (const pageId of pageIds) {
        await this.playwrightService.releasePage(pageId);
      }
    }

    return { successCount, failedCount };
  }

  /**
   * 상품 배치를 삭제하는 함수
   *
   * @param store - 스토어 이름
   * @param contextId - Playwright 컨텍스트 ID
   * @param pageId - 페이지 ID
   * @param productCodes - 삭제할 상품 코드 배열
   * @param cronId - 크론 작업 ID
   * @param type - 작업 유형
   * @param page - Playwright 페이지 객체
   * @returns 성공 및 실패 카운트를 포함한 객체
   */
  async deleteProductBatch(
    store: string,
    contextId: string,
    pageId: string,
    productCodes: string[],
    cronId: string,
    type: string,
    page: Page,
  ): Promise<{ successCount: number; failedCount: number }> {
    let successCount = 0;
    let failedCount = 0;

    // 각 상품 순차적으로 처리
    for (const [i, productCode] of productCodes.entries()) {
      try {
        const result = await this.deleteSingleProduct(
          store,
          contextId,
          pageId,
          productCode,
          cronId,
          type,
          page,
        );

        if (result) {
          successCount++;
        } else {
          failedCount++;
        }

        if (i % Math.ceil(productCodes.length / 10) === 0) {
          const progressPercentage = ((i + 1) / productCodes.length) * 100;
          console.log(
            `${type}${cronId}: ${pageId} - 상품 처리 중 ${i + 1}/${productCodes.length} (${progressPercentage.toFixed(2)}%)`,
          );
        }
      } catch (error) {
        console.error(`${type}${cronId} - ${pageId}: 상품 ${productCode} 처리 중 오류 발생`, error);
        failedCount++;
      }
    }

    return { successCount, failedCount };
  }

  /**
   * 대화상자 이벤트 핸들러를 설정합니다.
   *
   * @param page - Playwright 페이지 객체
   * @param cronId - 크론 작업 ID
   * @param type - 작업 유형
   */
  private setupDialogHandler(page: Page, cronId: string, type: string): void {
    // 기존 대화상자 리스너 제거 (중복 처리 방지)
    page.removeAllListeners('dialog');

    // 새 대화상자 리스너 등록
    page.on('dialog', async (dialog) => {
      try {
        const message = dialog.message();

        // 대화상자 수락
        await dialog.accept();
      } catch (error: any) {
        console.error(`${type}${cronId}: 대화상자 처리 실패 - ${error.message}`);
      }
    });
  }

  /**
   * 단일 상품 삭제 작업을 수행합니다.
   *
   * @param store - 스토어 타입
   * @param contextId - Playwright 컨텍스트 ID
   * @param pageId - 페이지 ID
   * @param productCode - 삭제할 상품 코드
   * @param cronId - 크론 작업 ID
   * @param type - 작업 유형
   * @param existingPage - (선택적) 이미 생성된 페이지
   * @returns 성공 여부 (boolean)
   *
   * @description
   * - 상품 관리 페이지로 이동하여 삭제 버튼 클릭
   * - 대화상자 이벤트 처리
   * - 성공/실패 로깅 및 에러 처리
   */
  async deleteSingleProduct(
    store: string,
    contextId: string,
    pageId: string,
    productCode: string,
    cronId: string,
    type: string,
    existingPage?: Page,
  ): Promise<boolean> {
    let onchPage: Page | undefined;
    const shouldReleasePage = !existingPage;

    try {
      // 페이지 생성 또는 기존 페이지 사용
      if (existingPage) {
        onchPage = existingPage;
      } else {
        onchPage = await this.playwrightService.loginToOnchSite(store, contextId, pageId);
      }

      if (!onchPage) {
        console.error(`${type}${cronId}: 페이지 생성 실패 - 상품 "${productCode}"`);
        return false;
      }

      // 페이지 로드 완료 대기
      try {
        await onchPage.waitForLoadState('networkidle', { timeout: 10000 });
      } catch (e) {
        console.warn(
          `${type}${cronId}: 페이지 로드 타임아웃 - 상품 "${productCode}", 계속 진행합니다`,
        );
      }

      await onchPage.waitForTimeout(1000);

      // 대화상자 처리 핸들러 설정
      this.setupDialogHandler(onchPage, cronId, type);

      // 상품 페이지로 이동
      try {
        await onchPage.goto(`https://www.onch3.co.kr/admin_mem_prd_list.html?ost=${productCode}`, {
          waitUntil: 'networkidle',
          timeout: 15000,
        });
      } catch (e) {
        console.warn(
          `${type}${cronId}: 페이지 이동 타임아웃 - 상품 "${productCode}", 계속 진행합니다`,
        );
      }

      // await new Promise((resolve) => setTimeout(resolve, 500));
      await onchPage.waitForTimeout(1000);

      // 삭제 버튼 찾기
      const deleteButton = onchPage.locator('a[onclick^="prd_list_del"]');
      let hasDeleteButton = false;

      try {
        await deleteButton.waitFor({ state: 'visible', timeout: 5000 });
        hasDeleteButton = (await deleteButton.count()) > 0;
      } catch (e) {
        console.warn(`${type}${cronId}: 삭제 버튼 없음 - 상품 "${productCode}"`);
        hasDeleteButton = false;
      }

      if (hasDeleteButton) {
        try {
          // 삭제 버튼 클릭 - 대화상자 이벤트를 기다리지 않음
          await deleteButton.click({ timeout: 5000 });

          // 대화상자 처리를 위한 충분한 대기 시간
          await onchPage.waitForTimeout(1000);

          return true;
        } catch (e) {
          console.error(`${type}${cronId}: 삭제 버튼 클릭 실패 - 상품 "${productCode}"`, e);
          return false;
        }
      } else {
        console.log(`${type}${cronId}: 상품 "${productCode}"에 대한 삭제 버튼을 찾을 수 없음`);
        return false;
      }
    } catch (error: any) {
      console.error(
        `${CronType.ERROR}${type}${cronId}: 상품 "${productCode}" 삭제 중 오류 발생\n`,
        error.message,
      );
      return false;
    } finally {
      if (shouldReleasePage && onchPage) {
        try {
          await this.playwrightService.releasePage(pageId);
        } catch (e) {
          console.error(`${type}${cronId}: 페이지 릴리즈 실패 - ${pageId}`, e);
        }
      }
    }
  }
}
