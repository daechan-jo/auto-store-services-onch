import { CronType, Dialog } from '@daechanjo/models';
import { PlaywrightService } from '@daechanjo/playwright';
import { Injectable } from '@nestjs/common';
import { Page } from 'playwright';

@Injectable()
export class DeleteProductsProvider {
  constructor(private readonly playwrightService: PlaywrightService) {}

  /**
   * 여러 플랫폼의 품절 상품 데이터에서 온채널 상품 코드를 추출하고 중복을 제거합니다.
   *
   * @param coupangProducts - 쿠팡 플랫폼에서 품절된 상품 목록
   * @param naverProducts - 네이버 플랫폼에서 품절된 상품 목록 (선택적)
   * @returns 중복이 제거된 온채널 상품 코드 배열
   *
   * @description
   * - 쿠팡 상품에서는 sellerProductName에서 'CH'로 시작하는 7자리 숫자 코드를 추출
   * - 네이버 상품에서는 sellerManagementCode 필드에서 코드를 추출
   * - Set 객체를 사용하여 중복 코드를 자동으로 제거
   */
  extractProductCodes(coupangProducts: any[], naverProducts?: any[]): string[] {
    const productCodesSet = new Set<string>();

    // 쿠팡 상품 코드 추출
    for (const product of coupangProducts) {
      const productCode = product.sellerProductName.match(/CH\d{7}/)?.[0];
      if (productCode) {
        productCodesSet.add(productCode);
      }
    }

    // 네이버 상품 코드 추출 (선택적)
    if (naverProducts) {
      for (const product of naverProducts) {
        const productCode = product.sellerManagementCode;
        if (productCode) {
          productCodesSet.add(productCode);
        }
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
   * - BATCH_SIZE 단위로 병렬 처리하여 성능 최적화
   * - 각 배치 완료 후 진행률 로깅
   * - 모든 작업의 성공/실패 카운트 집계
   */
  async performBatchDeletion(
    contextId: string,
    cronId: string,
    store: string,
    type: string,
    productCodes: string[],
  ): Promise<{ successCount: number; failedCount: number }> {
    const BATCH_SIZE = 2;
    let successCount = 0;
    let failedCount = 0;
    const totalProducts = productCodes.length;

    // 배치 단위로 처리
    for (let i = 0; i < totalProducts; i += BATCH_SIZE) {
      const batchItems = productCodes.slice(i, i + BATCH_SIZE);
      const batchPromises = batchItems.map(async (productCode, batchIndex) => {
        const result = await this.deleteSingleProduct(
          contextId,
          `page-${store}-${cronId}-${i + batchIndex}`,
          productCode,
          cronId,
          type,
        );

        if (result) {
          successCount++;
        } else {
          failedCount++;
        }
      });

      // 현재 배치의 모든 작업 완료 대기
      await Promise.all(batchPromises);

      // 진행률 로깅
      const processedCount = Math.min(i + BATCH_SIZE, totalProducts);
      console.log(
        `${type}${cronId}: 진행률 ${processedCount}/${totalProducts} (${Math.round((processedCount / totalProducts) * 100)}%)`,
      );
    }

    return { successCount, failedCount };
  }

  /**
   * Playwright 페이지에 대화상자 자동 처리를 위한 이벤트 핸들러를 등록합니다.
   *
   * @param page - 대화상자 핸들러를 등록할 Playwright 페이지 객체
   * @param cronId - 로깅을 위한 크론 작업 식별자
   * @param type - 로깅을 위한 작업 유형 식별자
   *
   * @description
   * - 페이지에서 발생하는 모든 대화상자(alert, confirm 등)를 자동으로 수락
   * - 대화상자 처리 과정 및 오류를 로깅
   * - 기본적으로 모든 대화상자를 accept()로 처리 (확인 버튼 클릭)
   */
  setupDialogHandler(page: Page, cronId: string, type: string): void {
    page.on('dialog', async (dialog: Dialog) => {
      try {
        console.log(`${type}${cronId}: ${dialog.type()} 대화상자 처리 - ${dialog.message()}`);
        await dialog.accept();
      } catch (error: any) {
        console.error(`${CronType.ERROR}${type}${cronId}: 대화상자 처리 실패 - ${error.message}`);
      }
    });
  }

  /**
   * 단일 상품 삭제 작업을 수행합니다.
   *
   * @param contextId - Playwright 컨텍스트 ID
   * @param pageId - 페이지 ID
   * @param productCode - 삭제할 상품 코드
   * @param cronId - 크론 작업 ID
   * @param type - 작업 유형
   * @returns 성공 여부 (boolean)
   *
   * @description
   * - 상품 관리 페이지로 이동하여 삭제 버튼 클릭
   * - 대화상자 이벤트 처리
   * - 성공/실패 로깅 및 에러 처리
   */
  async deleteSingleProduct(
    contextId: string,
    pageId: string,
    productCode: string,
    cronId: string,
    type: string,
  ): Promise<boolean> {
    let page = null;

    try {
      // 페이지 생성
      page = await this.playwrightService.createPage(contextId, pageId);

      // 대화상자 처리 핸들러 설정
      this.setupDialogHandler(page, cronId, type);

      // 상품 페이지로 이동
      await page.goto(`https://www.onch3.co.kr/admin_mem_prd_list.html?ost=${productCode}`, {
        waitUntil: 'domcontentloaded',
      });

      // 삭제 버튼 찾기
      const deleteButton = page.locator('a[onclick^="prd_list_del"]');
      const hasDeleteButton = (await deleteButton.count()) > 0;

      if (hasDeleteButton) {
        // 삭제 버튼 클릭 및 대화상자 처리를 위한 기다림
        await Promise.all([
          // 삭제 버튼 클릭
          deleteButton.click(),
          // 대화상자가 나타날 때까지 대기 (옵션)
          page.waitForEvent('dialog', { timeout: 2000 }).catch(() => {}),
        ]);

        // 대화상자 처리를 위한 최소 대기 시간
        await page.waitForTimeout(300);

        console.log(`${type}${cronId}: 상품 "${productCode}" 삭제 완료`);
        return true;
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
      // 페이지 리소스 해제
      if (page) {
        await this.playwrightService.releasePage(pageId);
      }
    }
  }
}
