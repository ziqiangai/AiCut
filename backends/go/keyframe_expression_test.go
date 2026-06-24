package main

import (
	"math"
	"strconv"
	"strings"
	"testing"
)

// Minimal ffmpeg-expression evaluator for tests. Supports the exact
// subset our compiler emits: lt, gte, pow, if, +-*/, parens, decimal
// numbers, and `t`. Mirrors the JS helper in the TS backend so the
// same assertions hold both sides.

type exprNode interface{ eval(t float64) float64 }
type numNode struct{ v float64 }
type tNode struct{}
type binNode struct {
	op       byte
	lhs, rhs exprNode
}
type callNode struct {
	name string
	args []exprNode
}

func (n numNode) eval(_ float64) float64 { return n.v }
func (tNode) eval(t float64) float64     { return t }
func (n binNode) eval(t float64) float64 {
	a, b := n.lhs.eval(t), n.rhs.eval(t)
	switch n.op {
	case '+':
		return a + b
	case '-':
		return a - b
	case '*':
		return a * b
	case '/':
		return a / b
	}
	panic("bad op")
}
func (n callNode) eval(t float64) float64 {
	switch n.name {
	case "lt":
		if n.args[0].eval(t) < n.args[1].eval(t) {
			return 1
		}
		return 0
	case "gte":
		if n.args[0].eval(t) >= n.args[1].eval(t) {
			return 1
		}
		return 0
	case "pow":
		return math.Pow(n.args[0].eval(t), n.args[1].eval(t))
	case "if":
		if n.args[0].eval(t) != 0 {
			return n.args[1].eval(t)
		}
		return n.args[2].eval(t)
	}
	panic("unknown fn " + n.name)
}

type parser struct {
	src string
	pos int
}

func (p *parser) peek() byte {
	if p.pos >= len(p.src) {
		return 0
	}
	return p.src[p.pos]
}
func (p *parser) take() byte { c := p.peek(); p.pos++; return c }

func (p *parser) parseExpr() exprNode { return p.parseAddSub() }
func (p *parser) parseAddSub() exprNode {
	lhs := p.parseMulDiv()
	for p.peek() == '+' || p.peek() == '-' {
		op := p.take()
		lhs = binNode{op, lhs, p.parseMulDiv()}
	}
	return lhs
}
func (p *parser) parseMulDiv() exprNode {
	lhs := p.parseUnary()
	for p.peek() == '*' || p.peek() == '/' {
		op := p.take()
		lhs = binNode{op, lhs, p.parseUnary()}
	}
	return lhs
}
func (p *parser) parseUnary() exprNode {
	if p.peek() == '-' {
		p.take()
		return binNode{'-', numNode{0}, p.parseAtom()}
	}
	if p.peek() == '+' {
		p.take()
	}
	return p.parseAtom()
}
func (p *parser) parseAtom() exprNode {
	c := p.peek()
	if c == '(' {
		p.take()
		e := p.parseExpr()
		if p.peek() != ')' {
			panic("expected ) at " + strconv.Itoa(p.pos))
		}
		p.take()
		return e
	}
	if (c >= '0' && c <= '9') || c == '.' {
		start := p.pos
		for {
			c := p.peek()
			if (c >= '0' && c <= '9') || c == '.' {
				p.take()
			} else {
				break
			}
		}
		v, err := strconv.ParseFloat(p.src[start:p.pos], 64)
		if err != nil {
			panic(err)
		}
		return numNode{v}
	}
	if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') {
		start := p.pos
		for {
			c := p.peek()
			if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') {
				p.take()
			} else {
				break
			}
		}
		name := p.src[start:p.pos]
		if p.peek() == '(' {
			p.take()
			var args []exprNode
			if p.peek() != ')' {
				args = append(args, p.parseExpr())
				for p.peek() == ',' {
					p.take()
					args = append(args, p.parseExpr())
				}
			}
			if p.peek() != ')' {
				panic("expected ) after fn args")
			}
			p.take()
			return callNode{name, args}
		}
		if name == "t" {
			return tNode{}
		}
		panic("unknown identifier " + name)
	}
	panic("unexpected char " + string(c))
}

func evalExpr(expr string, t float64) float64 {
	p := &parser{src: strings.ReplaceAll(expr, " ", "")}
	return p.parseExpr().eval(t)
}

// ----- compiler tests --------------------------------------------------

func TestCompileKeyframeExpression_NoKf_ReturnsFallback(t *testing.T) {
	if got := compileKeyframeExpression(nil, "panX", 0); got != "0" {
		t.Fatalf("got %q", got)
	}
	if got := compileKeyframeExpression([]Keyframe{}, "scale", 1.5); got != "1.5" {
		t.Fatalf("got %q", got)
	}
}

func TestCompileKeyframeExpression_SingleKf_Constant(t *testing.T) {
	kfs := []Keyframe{{ID: "k1", Prop: "scale", Time: 1000, Value: 2}}
	if got := compileKeyframeExpression(kfs, "scale", 1); got != "2" {
		t.Fatalf("got %q", got)
	}
}

func TestCompileKeyframeExpression_Linear(t *testing.T) {
	kfs := []Keyframe{
		{ID: "a", Prop: "scale", Time: 0, Value: 1},
		{ID: "b", Prop: "scale", Time: 1000, Value: 2},
	}
	expr := compileKeyframeExpression(kfs, "scale", 1)
	cases := []struct{ t, want float64 }{
		{0, 1}, {0.5, 1.5}, {1, 2}, {2, 2}, // after-last held
	}
	for _, c := range cases {
		got := evalExpr(expr, c.t)
		if math.Abs(got-c.want) > 1e-5 {
			t.Errorf("t=%v want %v got %v\nexpr=%s", c.t, c.want, got, expr)
		}
	}
}

func TestCompileKeyframeExpression_EaseIn(t *testing.T) {
	kfs := []Keyframe{
		{ID: "a", Prop: "scale", Time: 0, Value: 0, Easing: "easeIn"},
		{ID: "b", Prop: "scale", Time: 1000, Value: 1},
	}
	expr := compileKeyframeExpression(kfs, "scale", 0)
	// easeIn(0.5) = 0.5^3 = 0.125
	if got := evalExpr(expr, 0.5); math.Abs(got-0.125) > 1e-5 {
		t.Fatalf("want 0.125 got %v\nexpr=%s", got, expr)
	}
}

func TestCompileKeyframeExpression_EaseOut(t *testing.T) {
	kfs := []Keyframe{
		{ID: "a", Prop: "scale", Time: 0, Value: 0, Easing: "easeOut"},
		{ID: "b", Prop: "scale", Time: 1000, Value: 1},
	}
	expr := compileKeyframeExpression(kfs, "scale", 0)
	// easeOut(0.5) = 1 - (1-0.5)^3 = 1 - 0.125 = 0.875
	if got := evalExpr(expr, 0.5); math.Abs(got-0.875) > 1e-5 {
		t.Fatalf("want 0.875 got %v\nexpr=%s", got, expr)
	}
}

func TestCompileKeyframeExpression_EaseInOut_Symmetric(t *testing.T) {
	kfs := []Keyframe{
		{ID: "a", Prop: "scale", Time: 0, Value: 0, Easing: "easeInOut"},
		{ID: "b", Prop: "scale", Time: 1000, Value: 1},
	}
	expr := compileKeyframeExpression(kfs, "scale", 0)
	if got := evalExpr(expr, 0.5); math.Abs(got-0.5) > 1e-5 {
		t.Fatalf("want 0.5 got %v\nexpr=%s", got, expr)
	}
}

func TestCompileKeyframeExpression_BeforeAndAfterHold(t *testing.T) {
	kfs := []Keyframe{
		{ID: "a", Prop: "panX", Time: 1000, Value: 50},
		{ID: "b", Prop: "panX", Time: 2000, Value: 100},
	}
	expr := compileKeyframeExpression(kfs, "panX", 0)
	if v := evalExpr(expr, 0); math.Abs(v-50) > 1e-5 {
		t.Errorf("before-first want 50 got %v\nexpr=%s", v, expr)
	}
	if v := evalExpr(expr, 1.5); math.Abs(v-75) > 1e-5 {
		t.Errorf("mid want 75 got %v\nexpr=%s", v, expr)
	}
	if v := evalExpr(expr, 3); math.Abs(v-100) > 1e-5 {
		t.Errorf("after-last want 100 got %v\nexpr=%s", v, expr)
	}
}

func TestCompileKeyframeExpression_IgnoresOtherProps(t *testing.T) {
	kfs := []Keyframe{{ID: "a", Prop: "panX", Time: 0, Value: 999}}
	if got := compileKeyframeExpression(kfs, "panY", 42); got != "42" {
		t.Fatalf("got %q", got)
	}
}

func TestCompileKeyframeExpression_ZeroLengthSegmentSkipped(t *testing.T) {
	kfs := []Keyframe{
		{ID: "a", Prop: "scale", Time: 1000, Value: 1},
		{ID: "b", Prop: "scale", Time: 1000, Value: 2}, // same time
		{ID: "c", Prop: "scale", Time: 2000, Value: 3},
	}
	expr := compileKeyframeExpression(kfs, "scale", 1)
	if strings.Contains(expr, "NaN") || strings.Contains(expr, "Infinity") {
		t.Fatalf("unsafe expr: %s", expr)
	}
	if v := evalExpr(expr, 1.5); math.Abs(v-2.5) > 1e-5 {
		t.Errorf("want 2.5 got %v\nexpr=%s", v, expr)
	}
}

func TestFormatNumber_IntegerStaysInteger(t *testing.T) {
	if got := formatNumber(2); got != "2" {
		t.Errorf("got %q", got)
	}
	if got := formatNumber(2.5); got != "2.5" {
		t.Errorf("got %q", got)
	}
	if got := formatNumber(0.1); got != "0.1" {
		t.Errorf("got %q", got)
	}
}
