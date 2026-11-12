# Release ve sürüm yönetimi politikası

Bu belge OpenDevBoard sürüm yönetiminin kanonik kaynağıdır. Yayın kararı, yayınlanacak commit ve o commit için güncel kanıtlar üzerinden verilir.

## Sürümleme

[Semantic Versioning](https://semver.org/) kullanılır. Git tag'i ve GitHub Release başlığı tamamen aynı `vMAJOR.MINOR.PATCH` biçimindedir: `v0.1.0`, `v0.1.1`, `v0.2.0`, `v1.0.0`. Alpha, Beta, RC veya başka sürüm son ekleri kullanılmaz. `v0.x` sürümleri de normal GitHub Release olarak yayımlanır (`draft=false`, `prerelease=false`).

- MAJOR, geriye uyumsuz değişiklikleri ifade eder; `v1.0.0` öncesinde API kararlılığı garanti edilmez.
- MINOR, anlamlı bir özellik veya özellik grubu için artırılır.
- PATCH, hata ve güvenlik düzeltmeleri, stabilizasyon ve geriye uyumlu küçük iyileştirmeler için artırılır.

`v1.0.0` ancak kararlı sürümün güvenlik, operasyon, dokümantasyon ve kurulum kabul kriterleri belirlenip tamamlandığında yayımlanır. Bu kriterlerin tamamlanması ayrıca doğrulanmalıdır.

## Issue, milestone, roadmap ve Release

Issue uygulanabilir teknik işi, milestone teknik kapsamı ve kabul kriterlerini, Release tamamlanmış sürümün yayımlanmış kaydını, roadmap ise gelecekteki geliştirmeleri gösterir. Her milestone Release üretmek zorunda değildir; bir Release birden fazla milestone'u birleştirebilir. Yalnızca PATCH için yeni milestone açmak zorunlu değildir. Gelecek kapsam ve milestone'lar kararlaştırılmadan kesinleşmiş gibi sunulmaz. İlk sürüm kapsamı mevcut uygulama ve doğrulanabilir kanıtlarla belirlenir.

## Release kabul kriterleri

Release oluşturulmadan önce aşağıdakilerin tümü gözden geçirilir:

1. İlgili geliştirme kapsamı tamamlanmış ve kabul kriterleri karşılanmıştır.
2. İlgili PR'lar `main`'e merge edilmiştir.
3. Son `main` commit SHA'sı doğrulanmış ve aynı SHA için GitHub Actions `web`, `api-tests`, `compose` ve `secret-scan` işleri başarılı olmuştur. Eski commit sonuçları yeni SHA'nın doğrulaması olarak sunulmaz.
4. Gerekli fixture E2E ve Docker Compose smoke kontrollerinin kapsamı ve sonuçları değerlendirilmiştir; çalıştırılmamış kontroller başarılı olarak sunulmaz.
5. Release Notes hazırlanmış, mevcut tag ve Release kayıtları kontrol edilmiştir.
6. Güncel workflow ve diğer ilgili otomasyonlar incelenerek tag veya Release tetikleyicilerinin deployment ya da package publishing yapmadığı doğrulanmıştır.
7. Kullanıcının bu yayın için açık onayı alınmıştır.

## Yayınlama akışı

1. Güncel `main` HEAD'ini doğrula.
2. Aynı SHA için başarılı CI sonuçlarını doğrula.
3. Release kabul kriterlerini incele.
4. Sürüm numarasını belirle.
5. Release Notes'u tamamla.
6. Kullanıcıdan açık yayın onayı al.
7. Doğrulanmış commit için Git tag oluştur.
8. Aynı tag ve başlıkla normal GitHub Release yayımla (`draft=false`, `prerelease=false`).
9. Tag, Release ve kaynak commit SHA eşleşmesini doğrula.
10. Sonucu ve bağlantıları raporla.

Release otomatik oluşturulmaz. Mevcut tag'i yeniden hedeflemek, geçmişi yeniden yazmak ve force push yasaktır. Yayın öncesi `main` değişirse yeni HEAD ve CI sonuçları yeniden doğrulanır.

## Release ve deployment

Git tag veya GitHub Release oluşturmak deployment anlamına gelmez. Mevcut yayın kapsamı yalnızca kaynak koddur. Docker image, binary package, container registry package ve Playwright browser binary'leri yayımlanmaz; GitHub'ın otomatik kaynak arşivleri kullanılabilir. Gelecekte container image veya binary yayımlamak için ayrıca açık kullanıcı onayı ve dependency, license ve security incelemesi gerekir.

Release yayını production bağlantısı, gerçek Azure DevOps PAT kullanımı veya production verisine erişim yetkisi vermez.

## Release Notes standardı

Başlık yalnızca sürüm numarasıdır: `vX.Y.Z`. Her Release Notes şu bölümleri içerir:

- **Özet**: Kullanıcı açısından tamamlanmış ve doğrulanabilir kapsam.
- **Doğrulama**: Gerçek sonuçlar, doğrulanan SHA ve varsa henüz yapılmamış kontroller.
- **Kurulum ve yayın kapsamı**: Kurulum bağlantısı, kaynak kod kapsamı ve dağıtım sınırları.

Gerektiğinde **Bilinen sorunlar**, **Compatibility / migration** ve **Geri dönüş bilgisi** eklenir. Sonraki sürümlerde Full Changelog bağlantısı eklenebilir. Otomatik oluşturulmuş ham commit listesi tek başına Release Notes sayılmaz.

[İlk sürüm notları taslağı](releases/v0.1.0-draft.md) yayın yetkisi vermez. Henüz yayımlanmamış sürüm README'de current version veya latest release olarak gösterilmez; ilk gerçek Release sonrasında uygun bağlantı veya badge eklenebilir.
