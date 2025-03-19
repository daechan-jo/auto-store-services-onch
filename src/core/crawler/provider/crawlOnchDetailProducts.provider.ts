import { OnchProduct } from '@daechanjo/models';
import { Injectable } from '@nestjs/common';
import { Page } from 'playwright';

@Injectable()
export class CrawlOnchDetailProductsProvider {
  /**
   * 상품 상세 페이지에서 정보를 추출하는 함수
   *
   * @param page - Playwright 페이지 객체
   * @param productId - 추출할 상품의 ID
   * @returns 추출된 상품 상세 정보
   */
  async extractProductDetails(page: Page, productId: string): Promise<OnchProduct> {
    await page.goto(
      `https://www.onch3.co.kr/dbcenter_renewal/dbcenter_view.html?num=${productId}`,
      {
        timeout: 30000,
        waitUntil: 'networkidle',
      },
    );

    // 상품 상세 정보 추출
    return page.evaluate(() => {
      const getTextContent = (selector: string) =>
        document
          .querySelector(selector)
          ?.textContent?.trim()
          .replace(/[^0-9]/g, '');

      const getOptionTextContent = (element: Element, selector: string) =>
        element.querySelector(selector)?.textContent?.trim() || '';

      const productCodeElement = Array.from(document.querySelectorAll('li')).find((li) =>
        li.querySelector('.prod_detail_title')?.textContent?.includes('제품코드'),
      );
      const productCode =
        productCodeElement?.querySelector('div:nth-child(2)')?.textContent!.trim() || null;

      // 소비자가
      const consumerPrice = +getTextContent('.price_info li:nth-child(1) .prod_cus_price') || null;

      // 판매사가
      const sellerPrice = +getTextContent('.price_info li:nth-child(2) div:nth-child(2)') || null;

      // 배송비
      const shippingCostElement = Array.from(document.querySelectorAll('li')).find((li) =>
        li.querySelector('.prod_detail_title')?.textContent?.includes('택배비/택배사'),
      );
      const shippingCostText =
        shippingCostElement?.querySelector('div:nth-child(2)')?.textContent || null;
      const shippingCostMatch = shippingCostText && shippingCostText.match(/일반\s([\d,]+)원/);

      const shippingCost = shippingCostMatch ? +shippingCostMatch[1].replace(/,/g, '') : null;

      const onchItems = Array.from(document.querySelectorAll('ul li'))
        .filter((li) => li.querySelector('.detail_page_name')) // 옵션명이 존재하는 li만 포함
        .map((li) => {
          const optionName = getOptionTextContent(li, '.detail_page_name');
          const consumerPrice = getOptionTextContent(li, '.detail_page_price_2').replace(
            /[^0-9]/g,
            '',
          );
          const sellerPrice = getOptionTextContent(li, '.detail_page_price_3').replace(
            /[^0-9]/g,
            '',
          );
          return {
            itemName: optionName,
            consumerPrice: +consumerPrice || null,
            sellerPrice: +sellerPrice || null,
          };
        });

      return {
        productCode,
        consumerPrice,
        sellerPrice,
        shippingCost,
        onchItems,
      };
    });
  }
}
