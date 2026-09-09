//! L-04相当: 同一プロセスで小入力1000回。全結果一致を確認する。
#[test]
fn small_input_1000_times() {
    for i in 0..1000 {
        let v = (i % 100) as i32;
        let r = poc_core_ffi::transform(&[v, v + 1, v + 2], 2, 1)
            .expect("transform");
        assert_eq!(r.values.len(), 3);
        assert_eq!(r.values[0], v * 2 + 1);
        assert_eq!(r.values[1], (v + 1) * 2 + 1);
        assert_eq!(r.values[2], (v + 2) * 2 + 1);
        let mut sum: u32 = 0;
        for val in &r.values {
            sum = sum.wrapping_add(*val as u32);
        }
        assert_eq!(r.checksum, sum);
    }
}
