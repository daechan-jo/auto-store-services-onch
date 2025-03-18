import { Injectable } from '@nestjs/common';
import { Page } from 'playwright';

@Injectable()
export class CrawlOnchRegisteredProductsProvider {
  /**
   * 온채널 관리자 사이트의 상품 목록 페이지를 페이지네이션하며 상품 ID를 추출합니다.
   *
   * @param page - Playwright 페이지 객체
   * @param cronId - 크론 작업 ID
   * @param type - 로그 유형
   * @returns {Promise<string[]>} - 추출된 모든 상품 ID 배열
   *
   * @description
   * - 페이지네이션을 통해 모든 상품 페이지를 순회
   * - 각 페이지에서 상품 고유번호(num 파라미터)를 수집
   * - 빈 페이지가 나올 때까지 크롤링 계속 진행
   * - 10페이지마다 진행 상황을 로깅
   */
  async crawlProductList(page: Page, cronId: string, type: string): Promise<string[]> {
    console.log(`${type}${cronId}: 온채널 판매상품 리스트업 시작...`);
    const allProductIds = [];
    let currentPage = 1;

    while (true) {
      await page.goto(
        `https://www.onch3.co.kr/admin_mem_prd_list.html?npage=100&page=${currentPage}`,
        { waitUntil: 'networkidle' },
      );

      // 현재 페이지에서 상품 고유번호 추출 (셀렉터 최적화)
      const productIds = await page.$$eval(
        'a[href^="./dbcenter_renewal/dbcenter_view.html?num="]',
        (links) =>
          links
            .map((link) => {
              const match = link.getAttribute('href')?.match(/num=(\d+)/);
              return match ? match[1] : null;
            })
            .filter((id) => id !== null),
      );

      // 상품 ID가 없으면 크롤링 중지
      if (productIds.length === 0) {
        console.log(`${type}${cronId}: 크롤링 중지 마지막 페이지-${currentPage}`);
        break;
      }

      allProductIds.push(...productIds);
      currentPage++;

      if (currentPage % 10 === 0)
        console.log(
          `${type}${cronId}: 진행중... 현재 ${currentPage}페이지, ${allProductIds.length}개 수집됨`,
        );
    }

    console.log(`${type}${cronId}: 온채널 판매상품 리스트업 완료 ${allProductIds.length} 개`);
    return allProductIds;
  }
}
